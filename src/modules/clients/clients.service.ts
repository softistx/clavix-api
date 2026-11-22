import { deleteClient } from "@softistx/janus-oauth";
import type { TokenExchangeRules } from "@/modules/client-policies";
import { validateTokenExchange } from "@/modules/client-policies";
import { CatalogError } from "@/modules/resources";
import type { CliTenant } from "@/shared/cli";
import {
  agentsOf,
  countClients,
  findClientView,
  listClientPage,
  matchesClient,
  refuseAgent,
  requireClientView,
  storeOf,
} from "./clients.reads";
import { registerForTenant } from "./clients.register";
import { checkSizes, clientIdOf, sameClient } from "./clients.rules";
import type {
  ClientListOptions,
  ClientsServiceOptions,
  ClientView,
  CreateClientInput,
  RegisterClientInput,
  TokenExchangeInput,
  UpdateClientInput,
} from "./clients.types";
import { sentSettings } from "./clients.utils";

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

  private register(
    tenant: CliTenant,
    input: Omit<RegisterClientInput, "tenant">,
  ) {
    const { db, now, detailTypes } = this.options;
    return registerForTenant({ db, now, detailTypes }, tenant, input);
  }

  /** One page of the tenant's clients (see `listClientPage`). */
  list(tenant: CliTenant, options: ClientListOptions) {
    return listClientPage(this.options, tenant, options);
  }

  /** How many clients of the tenant match `q` and `kinds`, whatever the page. */
  count(
    tenant: CliTenant,
    options: Pick<ClientListOptions, "q" | "kinds"> = {},
  ) {
    return countClients(this.options, tenant, options);
  }

  /** A registered client; `null` for an unknown one (see `findClientView`). */
  find(
    tenant: CliTenant,
    clientId: string,
    options: { agents?: boolean } = {},
  ): Promise<ClientView | null> {
    return findClientView(this.options, tenant, clientId, options);
  }

  /** Whether `input` describes the stored client: a repeat of its creation. */
  matches(tenant: CliTenant, input: CreateClientInput): Promise<boolean> {
    return matchesClient(this.options, tenant, input);
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
      client: await requireClientView(
        this.options,
        tenant,
        registered.clientId,
      ),
      clientSecret: registered.clientSecret,
    };
  }

  /** Replaces the name, the redirect URIs, the grants and/or the detail types; the type and the secret stay. */
  async update(
    tenant: CliTenant,
    clientId: string,
    input: UpdateClientInput,
  ): Promise<ClientView> {
    await refuseAgent(this.options, tenant, clientId);
    checkSizes(input);
    const current = await requireClientView(this.options, tenant, clientId);
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
    return requireClientView(this.options, tenant, clientId);
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
    await refuseAgent(this.options, tenant, clientId);
    const client = await requireClientView(this.options, tenant, clientId);
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
    await refuseAgent(this.options, tenant, clientId);
    const current = await requireClientView(this.options, tenant, clientId);
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
      client: await requireClientView(this.options, tenant, clientId),
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
    const store = storeOf(this.options, tenant);
    // A client the agents store knows is deleted like any other, a metadata
    // one included (it is fetched again, and recorded again, at its next use).
    const agent = (await agentsOf(this.options, tenant)([clientId])).has(
      clientId,
    );
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
