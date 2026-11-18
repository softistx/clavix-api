import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";
import type { CliTenant } from "@/cli/errors";
import { clientIdOf, type registerClient } from "@/clients/register-client";
import type { TokenExchangeRules } from "@/modules/client-policies/client-policies.model";
import type { ClientPoliciesService } from "@/modules/client-policies/client-policies.service";
import { CatalogError } from "@/modules/resources/catalog.errors";
import type { ClientDetailTypes } from "@/modules/resources/detail-types/client-opt-in";
import { partitionOf } from "@/modules/tenants/identity";
import { deleteClientAndRules } from "./client-deletion";
import {
  type ClientView,
  capability,
  countClientViews,
  listClientViews,
  viewOf,
} from "./client-listing";
import { registerForTenant } from "./client-register";
import { checkQuery, checkSizes, MAX_CURSOR, sameClient } from "./client-rules";
import {
  clientTokenExchange,
  setClientTokenExchange,
  tokenExchangesOf,
} from "./client-token-exchange";

export type { ClientView } from "./client-listing";

export interface ClientsServiceOptions {
  /** The plain driver `Db` of the janus OAuth collections (`oauthDb`). */
  db: Db;
  /** The clients' per-client rules, removed with the client. */
  policies: ClientPoliciesService;
  /** The tenant's agents: a deleted client stops being one (it frees the `agents` quota). */
  agents?: { remove(tenantId: string, clientId: string): Promise<void> };
  /** The tenants' detail types a client may list (R3); without it none can be listed. */
  detailTypes?: ClientDetailTypes;
  now?: () => Date;
}

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
    input: Omit<Parameters<typeof registerClient>[1], "tenant">,
  ) {
    return registerForTenant(
      {
        db: this.options.db,
        now: this.options.now,
        detailTypes: this.options.detailTypes,
      },
      tenant,
      input,
    );
  }

  async list(
    tenant: CliTenant,
    options: { after?: string | null; limit: number; q?: string | undefined },
  ) {
    checkQuery(options.q);
    if ((options.after?.length ?? 0) > MAX_CURSOR) {
      throw new CatalogError("BAD_USER_INPUT", "Unknown cursor");
    }
    return listClientViews(
      capability(this.storeOf(tenant).listClients, "listClients"),
      options,
    );
  }

  /** How many clients of the tenant match `q`, whatever the page. */
  async count(tenant: CliTenant, options: { q?: string | undefined } = {}) {
    checkQuery(options.q);
    return countClientViews(
      capability(this.storeOf(tenant).listClients, "listClients"),
      options,
    );
  }

  async find(tenant: CliTenant, clientId: string): Promise<ClientView | null> {
    const record = await this.storeOf(tenant).findClient(clientId);
    if (record === null || record.source !== "registered") return null;
    return viewOf(record);
  }

  private async require(tenant: CliTenant, clientId: string) {
    const found = await this.find(tenant, clientId);
    if (found === null) throw new CatalogError("NOT_FOUND", "No such client");
    return found;
  }

  /** Whether `input` describes the stored client: a repeat of its creation. */
  async matches(
    tenant: CliTenant,
    input: Parameters<ClientsService["create"]>[1],
  ): Promise<boolean> {
    const clientId = input.clientId ?? clientIdOf(input.name);
    if (clientId === "") return false;
    const existing = await this.find(tenant, clientId);
    return existing !== null && sameClient(existing, input);
  }

  /** A new client; `clientSecret` (confidential only) is returned here and nowhere else. */
  async create(
    tenant: CliTenant,
    input: {
      name: string;
      type: "public" | "confidential";
      redirectUris: readonly string[];
      clientId?: string | undefined;
      requirePar?: boolean | undefined;
      dpopBound?: boolean | undefined;
      /** The detail types the client may ask for (each a tenant type; needs `requirePar`). Default: none. */
      detailTypes?: readonly string[] | undefined;
      /** Default: `authorization_code` and `refresh_token`. */
      grants?: readonly string[] | undefined;
    },
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
      ...(input.requirePar === undefined
        ? {}
        : { requirePar: input.requirePar }),
      ...(input.dpopBound === undefined ? {} : { dpopBound: input.dpopBound }),
      ...(input.grants === undefined ? {} : { grants: input.grants }),
      ...(input.detailTypes === undefined
        ? {}
        : { detailTypes: input.detailTypes }),
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
    input: {
      name?: string | undefined;
      redirectUris?: readonly string[] | undefined;
      requirePar?: boolean | undefined;
      dpopBound?: boolean | undefined;
      detailTypes?: readonly string[] | undefined;
      grants?: readonly string[] | undefined;
    },
  ): Promise<ClientView> {
    checkSizes(input);
    const current = await this.require(tenant, clientId);
    await this.register(tenant, {
      name: input.name ?? current.name,
      redirectUris: input.redirectUris ?? current.redirectUris,
      type: current.type,
      clientId,
      requirePar:
        input.requirePar ?? current.requirePushedAuthorizationRequests,
      dpopBound: input.dpopBound ?? current.dpopBoundAccessTokens,
      // Kept as recorded unless the call changes them.
      grants: input.grants ?? current.grantTypes,
      // Left out, `registerClient` keeps the stored list (a stale type stays).
      ...(input.detailTypes === undefined
        ? {}
        : { detailTypes: input.detailTypes }),
    });
    return this.require(tenant, clientId);
  }

  /** The client's token exchange rules (RFC 8693); `null` when it has none. */
  tokenExchange(tenant: CliTenant, clientId: string) {
    return clientTokenExchange(this.options.policies, tenant, clientId);
  }

  /** The token exchange rules of these clients, by client id (one read). */
  tokenExchangeOf(tenant: CliTenant, clientIds: readonly string[]) {
    return tokenExchangesOf(this.options.policies, tenant, clientIds);
  }

  /** Replaces the client's token exchange rules; see `setClientTokenExchange`. */
  async setTokenExchange(
    tenant: CliTenant,
    clientId: string,
    input: {
      targetResources: readonly string[];
      subjectClients: readonly string[] | "any";
    },
    resourceUris: readonly string[],
  ): Promise<TokenExchangeRules> {
    return setClientTokenExchange(
      this.options.policies,
      tenant,
      await this.require(tenant, clientId),
      input,
      resourceUris,
    );
  }

  /** Mints a new secret (the old one stops working); shown here once. */
  async rotateSecret(
    tenant: CliTenant,
    clientId: string,
  ): Promise<{ client: ClientView; clientSecret: string }> {
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

  async delete(
    tenant: CliTenant,
    clientId: string,
  ): Promise<{ removed: boolean; unmanaged: boolean }> {
    const result = await deleteClientAndRules(
      this.storeOf(tenant),
      this.options.policies,
      tenant,
      clientId,
      (this.options.now ?? (() => new Date()))(),
    );
    // On a repeat too: a run that stopped between the two is finished.
    if (!result.unmanaged) {
      await this.options.agents?.remove(tenant._id.toHexString(), clientId);
    }
    return result;
  }
}
