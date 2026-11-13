import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";
import { CliInputError, type CliTenant } from "@/cli/errors";
import { clientIdOf, registerClient } from "@/clients/register-client";
import { CatalogError } from "@/modules/resources/catalog.errors";
import { partitionOf } from "@/modules/tenants/identity";
import {
  type ClientView,
  capability,
  listClientViews,
  viewOf,
} from "./client-listing";

export type { ClientView } from "./client-listing";

export interface ClientsServiceOptions {
  /** The plain driver `Db` of the janus OAuth collections (`oauthDb`). */
  db: Db;
  now?: () => Date;
}

const slugOnly = (tenant: CliTenant) => tenant.slug;

const MAX_NAME = 100;
const MAX_REDIRECT_URIS = 20;
const MAX_QUERY = 100;
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
    if ((options.q?.length ?? 0) > MAX_QUERY) {
      throw new CatalogError(
        "BAD_USER_INPUT",
        `a search has at most ${MAX_QUERY} characters`,
      );
    }
    if ((options.after?.length ?? 0) > MAX_CURSOR) {
      throw new CatalogError("BAD_USER_INPUT", "Unknown cursor");
    }
    return listClientViews(
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

  /** A new client; `clientSecret` (confidential only) is returned here and nowhere else. */
  async create(
    tenant: CliTenant,
    input: {
      name: string;
      type: "public" | "confidential";
      redirectUris: readonly string[];
      clientId?: string | undefined;
    },
  ): Promise<{ client: ClientView; clientSecret: string | null }> {
    checkSizes(input);
    const clientId = input.clientId ?? clientIdOf(input.name);
    const taken = new CatalogError(
      "CONFLICT",
      `A client already has the id "${clientId}"`,
    );
    if (clientId !== "" && (await this.find(tenant, clientId)) !== null) {
      throw taken;
    }
    const registered = await this.register(tenant, {
      name: input.name,
      redirectUris: input.redirectUris,
      type: input.type,
      clientId,
    });
    return {
      client: await this.require(tenant, registered.clientId),
      clientSecret: registered.clientSecret,
    };
  }

  /** Replaces the name and/or the redirect URIs; the type and the secret stay. */
  async update(
    tenant: CliTenant,
    clientId: string,
    input: {
      name?: string | undefined;
      redirectUris?: readonly string[] | undefined;
    },
  ): Promise<ClientView> {
    checkSizes(input);
    const current = await this.require(tenant, clientId);
    await this.register(tenant, {
      name: input.name ?? current.name,
      redirectUris: input.redirectUris ?? current.redirectUris,
      type: current.type,
      clientId,
    });
    return this.require(tenant, clientId);
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
   * Whether the id names a client this service does not manage (a record that
   * was not registered through the console or the script): `delete` leaves it
   * alone and the caller has nothing to record.
   */
  async isUnmanaged(tenant: CliTenant, clientId: string): Promise<boolean> {
    const record = await this.storeOf(tenant).findClient(clientId);
    return record !== null && record.source !== "registered";
  }

  /**
   * `false` when it was not there. The client goes first (nothing new can be
   * granted to it), then its standing grants and their tokens are revoked: on
   * a repeat too, so a run that stopped between the two is finished.
   */
  async delete(tenant: CliTenant, clientId: string): Promise<boolean> {
    const store = this.storeOf(tenant);
    const record = await store.findClient(clientId);
    if (record !== null && record.source !== "registered") return false;
    const removed = record !== null && (await store.deleteClient(clientId));
    await capability(store.revokeClientGrants, "revokeClientGrants")(
      clientId,
      (this.options.now ?? (() => new Date()))(),
    );
    return removed;
  }
}
