import { deleteClient } from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import type { TokenExchangeRules } from "@/modules/client-policies";
import { validateTokenExchange } from "@/modules/client-policies";
import { CatalogError } from "@/modules/resources";
import { partitionOf } from "@/modules/tenants";
import type { CliTenant } from "@/shared/cli";
import { registerForTenant } from "./clients.register";
import {
  checkQuery,
  checkSizes,
  clientIdOf,
  MAX_CURSOR,
  sameClient,
} from "./clients.rules";
import { countClientViews, listClientViews } from "./clients.search";
import type {
  ClientListOptions,
  ClientsServiceOptions,
  ClientView,
  CreateClientInput,
  RegisterClientInput,
  TokenExchangeInput,
  UpdateClientInput,
} from "./clients.types";
import {
  agentKindsOf,
  capability,
  sentSettings,
  viewOf,
} from "./clients.utils";

/**
 * A tenant's OAuth clients for the console. The janus store is the truth (one
 * partition per tenant, so another tenant's client is "not found") and lists
 * them (`listClients`); a record is mapped to a `ClientView`, so its
 * `secretHash` never leaves this class. Creating reuses `registerClient`, so
 * a console client follows the same rules as one made by script. Deleting
 * revokes the client's grants and tokens and is idempotent.
 */
export class ClientsService {
  constructor(private readonly options: ClientsServiceOptions) {}

  private storeOf(tenant: CliTenant) {
    return createMongoOAuth(this.options.db, {
      partition: partitionOf(tenant._id),
    });
  }

  private register(
    tenant: CliTenant,
    input: Omit<RegisterClientInput, "tenant">,
  ) {
    const { db, now, detailTypes } = this.options;
    return registerForTenant({ db, now, detailTypes }, tenant, input);
  }

  /** The tenant's agents among some client ids. */
  private agentsOf(tenant: CliTenant) {
    return agentKindsOf(this.options.agents, tenant);
  }

  /**
   * Refuses a write on an agent (dynamic or metadata): an agent is read-only in
   * the console, whatever its id looks like. It answers as an unknown client, and
   * runs before any validation that depends on the id.
   */
  private async refuseAgent(tenant: CliTenant, clientId: string) {
    if ((await this.agentsOf(tenant)([clientId])).has(clientId)) {
      throw new CatalogError("NOT_FOUND", "No such client");
    }
  }

  private async require(tenant: CliTenant, clientId: string) {
    const found = await this.find(tenant, clientId);
    if (found === null) throw new CatalogError("NOT_FOUND", "No such client");
    return found;
  }

  /**
   * One page of the tenant's clients. `kinds` keeps only those registrations
   * (`console`, `dynamic`, `metadata`); none: every one, the agents included.
   */
  async list(tenant: CliTenant, options: ClientListOptions) {
    checkQuery(options.q);
    if ((options.after?.length ?? 0) > MAX_CURSOR) {
      throw new CatalogError("BAD_USER_INPUT", "Unknown cursor");
    }
    return listClientViews(
      capability(this.storeOf(tenant).listClients, "listClients"),
      { ...options, agents: this.agentsOf(tenant) },
    );
  }

  /** How many clients of the tenant match `q` and `kinds`, whatever the page. */
  async count(
    tenant: CliTenant,
    options: Pick<ClientListOptions, "q" | "kinds"> = {},
  ) {
    checkQuery(options.q);
    return countClientViews(
      capability(this.storeOf(tenant).listClients, "listClients"),
      { ...options, agents: this.agentsOf(tenant) },
    );
  }

  /**
   * A registered client; `null` for an unknown one. A client a metadata
   * document describes is returned only with `agents: true` (the read-only
   * view of the console): the writes never see it.
   */
  async find(
    tenant: CliTenant,
    clientId: string,
    options: { agents?: boolean } = {},
  ): Promise<ClientView | null> {
    const record = await this.storeOf(tenant).findClient(clientId);
    if (record === null) return null;
    if (record.source !== "registered" && options.agents !== true) return null;
    return viewOf(record, await this.agentsOf(tenant)([clientId]));
  }

  /** Whether `input` describes the stored client: a repeat of its creation. */
  async matches(tenant: CliTenant, input: CreateClientInput): Promise<boolean> {
    const clientId = input.clientId ?? clientIdOf(input.name);
    if (clientId === "") return false;
    const existing = await this.find(tenant, clientId);
    return existing !== null && sameClient(existing, input);
  }

  /** A new client; `clientSecret` (confidential only) is returned here and nowhere else. */
  async create(
    tenant: CliTenant,
    input: CreateClientInput,
  ): Promise<{ client: ClientView; clientSecret: string | null }> {
    checkSizes(input);
    const clientId = input.clientId ?? clientIdOf(input.name);
    if (clientId !== "") {
      const existing = await this.find(tenant, clientId);
      if (existing !== null) {
        // A repeat of a call whose audit record failed: the same client, no
        // secret (it was returned, once, by the first run).
        if (sameClient(existing, input)) {
          return { client: existing, clientSecret: null };
        }
        throw new CatalogError(
          "CONFLICT",
          `A client already has the id "${clientId}"`,
        );
      }
    }
    const registered = await this.register(tenant, {
      name: input.name,
      redirectUris: input.redirectUris,
      type: input.type,
      clientId,
      ...sentSettings(input),
    });
    return {
      client: await this.require(tenant, registered.clientId),
      clientSecret: registered.clientSecret,
    };
  }

  /** Replaces the name, the redirect URIs, the grants and/or the detail types; the type and the secret stay. */
  async update(
    tenant: CliTenant,
    clientId: string,
    input: UpdateClientInput,
  ): Promise<ClientView> {
    await this.refuseAgent(tenant, clientId);
    checkSizes(input);
    const current = await this.require(tenant, clientId);
    await this.register(tenant, {
      name: input.name ?? current.name,
      redirectUris: input.redirectUris ?? current.redirectUris,
      type: current.type,
      clientId,
      // Left out, `registerClient` keeps the stored detail types and scopes
      // (a stale type stays; the scopes are dropped with the grant).
      ...sentSettings(input),
      // Kept as recorded unless the call changes them.
      requirePar:
        input.requirePar ?? current.requirePushedAuthorizationRequests,
      dpopBound: input.dpopBound ?? current.dpopBoundAccessTokens,
      grants: input.grants ?? current.grantTypes,
    });
    return this.require(tenant, clientId);
  }

  /** The client's token exchange rules (RFC 8693); `null` when it has none. */
  async tokenExchange(tenant: CliTenant, clientId: string) {
    return (
      (await this.options.policies.tokenExchange(tenant._id, clientId)) ?? null
    );
  }

  /** The token exchange rules of these clients, by client id (one read). */
  async tokenExchangeOf(tenant: CliTenant, clientIds: readonly string[]) {
    return (
      (await this.options.policies.tokenExchangeOf(tenant._id, clientIds)) ??
      new Map<string, TokenExchangeRules>()
    );
  }

  /**
   * Replaces the client's token exchange rules. The client is a confidential
   * one of the tenant, each target one of the tenant's resources
   * (`resourceUris`), and the subject clients are `"any"` or a list of
   * client ids (checked for shape only: a client may be created later), and
   * `subjectAgents` also covers the tokens of the tenant's agents (D12).
   * Delegation is the only mode.
   */
  async setTokenExchange(
    tenant: CliTenant,
    clientId: string,
    input: TokenExchangeInput,
    resourceUris: readonly string[],
  ): Promise<TokenExchangeRules> {
    await this.refuseAgent(tenant, clientId);
    const client = await this.require(tenant, clientId);
    if (client.type !== "confidential") {
      throw new CatalogError(
        "BAD_USER_INPUT",
        "Only a confidential client can exchange tokens",
      );
    }
    const { targets, subjects, agents } = validateTokenExchange(
      input,
      resourceUris,
    );
    return this.options.policies.setTokenExchange(tenant._id, clientId, {
      targetResources: targets,
      subjectClients: subjects,
      subjectAgents: agents,
      mode: "delegation",
    });
  }

  /** Mints a new secret (the old one stops working); shown here once. */
  async rotateSecret(
    tenant: CliTenant,
    clientId: string,
  ): Promise<{ client: ClientView; clientSecret: string }> {
    await this.refuseAgent(tenant, clientId);
    const current = await this.require(tenant, clientId);
    if (current.type !== "confidential") {
      throw new CatalogError(
        "BAD_USER_INPUT",
        "A public client has no secret to rotate",
      );
    }
    const registered = await this.register(tenant, {
      name: current.name,
      redirectUris: current.redirectUris,
      type: "confidential",
      clientId,
      grants: current.grantTypes,
      rotateSecret: true,
    });
    if (registered.clientSecret === null) {
      throw new Error("rotating a confidential client minted no secret");
    }
    return {
      client: await this.require(tenant, clientId),
      clientSecret: registered.clientSecret,
    };
  }

  /**
   * Deletes the client. `unmanaged` is a record this service does not manage
   * (not registered through the console or the script, and no recorded agent):
   * it is left alone, and the caller has nothing to record. `removed` is
   * `false` when it was not there. One read decides both, so the answer cannot
   * disagree with what was done. The client goes first (nothing new can be
   * granted to it), then its standing grants and their tokens are revoked, its
   * rules removed: on a repeat too, so a run that stopped between the steps is
   * finished.
   */
  async delete(
    tenant: CliTenant,
    clientId: string,
  ): Promise<{ removed: boolean; unmanaged: boolean }> {
    const { policies, agents } = this.options;
    const store = this.storeOf(tenant);
    // A client the agents store knows is deleted like any other, a metadata
    // one included (it is fetched again, and recorded again, at its next use).
    const agent = (await this.agentsOf(tenant)([clientId])).has(clientId);
    const record = await store.findClient(clientId);
    if (record !== null && record.source !== "registered" && !agent) {
      return { removed: false, unmanaged: true };
    }
    const removed = await deleteClient(store, clientId, {
      now: this.options.now(),
    });
    // The client's rules go with it, and it leaves the other clients' rules
    // that name it as a subject.
    await policies.deleteForClient(tenant._id, clientId);
    await policies.removeSubjectClient(tenant._id, clientId);
    await agents.remove(tenant._id.toHexString(), clientId);
    return { removed, unmanaged: false };
  }
}
