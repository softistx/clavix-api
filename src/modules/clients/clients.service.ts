import { deleteClient } from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";
import { CliInputError, type CliTenant } from "@/cli/errors";
import { clientIdOf, registerClient } from "@/clients/register-client";
import type { TokenExchangeRules } from "@/modules/client-policies/client-policies.model";
import type { ClientPoliciesService } from "@/modules/client-policies/client-policies.service";
import { CatalogError } from "@/modules/resources/catalog.errors";
import { partitionOf } from "@/modules/tenants/identity";
import {
  type ClientView,
  capability,
  countClientViews,
  listClientViews,
  viewOf,
} from "./client-listing";

export type { ClientView } from "./client-listing";

export interface ClientsServiceOptions {
  /** The plain driver `Db` of the janus OAuth collections (`oauthDb`). */
  db: Db;
  /** The clients' per-client rules, removed with the client. */
  policies: ClientPoliciesService;
  now?: () => Date;
}

const slugOnly = (tenant: CliTenant) => tenant.slug;

const MAX_NAME = 100;
const MAX_REDIRECT_URIS = 20;
const MAX_QUERY = 100;
const MAX_TARGETS = 20;
const MAX_SUBJECT_CLIENTS = 50;
const SUBJECT_ID = /^[a-z0-9-]{1,64}$/;
const MAX_CURSOR = 200;

function checkSizes(input: {
  name?: string | undefined;
  redirectUris?: readonly string[] | undefined;
}) {
  if ((input.name?.length ?? 0) > MAX_NAME) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      `a client's name has at most ${MAX_NAME} characters`,
    );
  }
  if ((input.redirectUris?.length ?? 0) > MAX_REDIRECT_URIS) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      `a client has at most ${MAX_REDIRECT_URIS} redirect URIs`,
    );
  }
}

/** The stored client has the input's name, type and redirect URIs. */
function sameClient(
  stored: ClientView,
  input: {
    name: string;
    type: "public" | "confidential";
    redirectUris: readonly string[];
    requirePar?: boolean | undefined;
    dpopBound?: boolean | undefined;
    grants?: readonly string[] | undefined;
  },
) {
  const wanted = new Set(input.redirectUris);
  const wantedGrants = new Set(input.grants);
  return (
    (input.grants === undefined ||
      (stored.grantTypes.length === wantedGrants.size &&
        stored.grantTypes.every((grant) => wantedGrants.has(grant)))) &&
    stored.name === input.name.trim() &&
    stored.type === input.type &&
    (input.requirePar === undefined ||
      input.requirePar === stored.requirePushedAuthorizationRequests) &&
    (input.dpopBound === undefined ||
      input.dpopBound === stored.dpopBoundAccessTokens) &&
    stored.redirectUris.length === wanted.size &&
    stored.redirectUris.every((uri) => wanted.has(uri))
  );
}

/**
 * A tenant's OAuth clients for the console. The janus store is the truth (one
 * partition per tenant, so another tenant's client is "not found") and lists
 * them (`listClients`); a record is mapped to a `ClientView`, so its
 * `secretHash` never leaves this class. Creating reuses `registerClient`, so a console client follows the same rules
 * as one made by script. Deleting revokes the client's grants and tokens and
 * is idempotent.
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
    return registerClient(
      {
        db: this.options.db,
        findTenant: async (slug) => (slug === tenant.slug ? tenant : undefined),
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      },
      { ...input, tenant: slugOnly(tenant) },
    ).catch((error) => {
      if (error instanceof CliInputError) {
        throw new CatalogError("BAD_USER_INPUT", error.message);
      }
      throw error;
    });
  }

  async list(
    tenant: CliTenant,
    options: { after?: string | null; limit: number; q?: string | undefined },
  ) {
    this.checkQuery(options.q);
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
    this.checkQuery(options.q);
    return countClientViews(
      capability(this.storeOf(tenant).listClients, "listClients"),
      options,
    );
  }

  private checkQuery(q: string | undefined) {
    if ((q?.length ?? 0) > MAX_QUERY) {
      throw new CatalogError(
        "BAD_USER_INPUT",
        `a search has at most ${MAX_QUERY} characters`,
      );
    }
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
    });
    return {
      client: await this.require(tenant, registered.clientId),
      clientSecret: registered.clientSecret,
    };
  }

  /** Replaces the name, the redirect URIs and/or the grants; the type and the secret stay. */
  async update(
    tenant: CliTenant,
    clientId: string,
    input: {
      name?: string | undefined;
      redirectUris?: readonly string[] | undefined;
      requirePar?: boolean | undefined;
      dpopBound?: boolean | undefined;
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
   * client ids (checked for shape only: a client may be created later).
   * Delegation is the only mode.
   */
  async setTokenExchange(
    tenant: CliTenant,
    clientId: string,
    input: {
      targetResources: readonly string[];
      subjectClients: readonly string[] | "any";
    },
    resourceUris: readonly string[],
  ): Promise<TokenExchangeRules> {
    const policies = this.options.policies;
    const client = await this.require(tenant, clientId);
    if (client.type !== "confidential") {
      throw new CatalogError(
        "BAD_USER_INPUT",
        "Only a confidential client can exchange tokens",
      );
    }
    const targets = [...new Set(input.targetResources)];
    if (targets.length > MAX_TARGETS) {
      throw new CatalogError(
        "BAD_USER_INPUT",
        `a client exchanges for at most ${MAX_TARGETS} resources`,
      );
    }
    const unknown = targets.find((uri) => !resourceUris.includes(uri));
    if (unknown !== undefined) {
      throw new CatalogError(
        "BAD_USER_INPUT",
        `"${unknown}" is not a resource of this tenant`,
      );
    }
    const subjects =
      input.subjectClients === "any"
        ? "any"
        : [...new Set(input.subjectClients)];
    if (subjects !== "any") {
      if (subjects.length > MAX_SUBJECT_CLIENTS) {
        throw new CatalogError(
          "BAD_USER_INPUT",
          `a client exchanges the tokens of at most ${MAX_SUBJECT_CLIENTS} clients`,
        );
      }
      const bad = subjects.find((id) => !SUBJECT_ID.test(id));
      if (bad !== undefined) {
        throw new CatalogError(
          "BAD_USER_INPUT",
          `"${bad}" is not a client id (a-z, 0-9 and "-")`,
        );
      }
    }
    return policies.setTokenExchange(tenant._id, clientId, {
      targetResources: targets,
      subjectClients: subjects,
      mode: "delegation",
    });
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

  /**
   * Deletes the client. `unmanaged` is a record this service does not manage (not
   * registered through the console or the script): it is left alone, and the
   * caller has nothing to record. `removed` is `false` when it was not there.
   * One read decides both, so the answer cannot disagree with what was done.
   * The client goes first (nothing new can be granted to it), then its
   * standing grants and their tokens are revoked: on a repeat too, so a run
   * that stopped between the two is finished.
   */
  async delete(
    tenant: CliTenant,
    clientId: string,
  ): Promise<{ removed: boolean; unmanaged: boolean }> {
    const store = this.storeOf(tenant);
    const record = await store.findClient(clientId);
    if (record !== null && record.source !== "registered") {
      return { removed: false, unmanaged: true };
    }
    const removed = await deleteClient(store, clientId, {
      now: (this.options.now ?? (() => new Date()))(),
    });
    // The client's rules (`clientPolicies`) go with it, on a repeat too.
    await this.options.policies.deleteForClient(tenant._id, clientId);
    return { removed, unmanaged: false };
  }
}
