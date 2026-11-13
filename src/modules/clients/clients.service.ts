import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { InvalidCursorError } from "@softistx/mongo";
import type { Db } from "mongodb";
import { CliInputError, type CliTenant } from "@/cli/errors";
import { clientIdOf, registerClient } from "@/clients/register-client";
import { CatalogError } from "@/modules/resources/catalog.errors";
import { partitionOf } from "@/modules/tenants/identity";
import type { ClientIndex } from "./client-index";

export interface ClientView {
  clientId: string;
  name: string;
  type: "public" | "confidential";
  redirectUris: readonly string[];
  createdAt: Date;
}

export interface ClientsServiceOptions {
  /** The plain driver `Db` of the janus OAuth collections (`oauthDb`). */
  db: Db;
  index: ClientIndex;
  now?: () => Date;
}

const slugOnly = (tenant: CliTenant) => tenant.slug;

const MAX_NAME = 100;
const MAX_REDIRECT_URIS = 20;
const MAX_QUERY = 100;

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
 * partition per tenant, so another tenant's client is "not found"); the
 * `clientIndex` shadow, kept by `registerClient`, is what lists them.
 * Creating reuses `registerClient`, so a console client follows the same rules
 * as one made by script. Deleting is idempotent.
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
        index: this.options.index,
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
    const page = await this.options.index
      .page(tenant._id, options)
      .catch((error) => {
        if (error instanceof InvalidCursorError) {
          throw new CatalogError("BAD_USER_INPUT", "Unknown cursor");
        }
        throw error;
      });
    // The index says which clients and in what order; each is read from the
    // janus store, the truth (one the store lost is left out).
    const found = await Promise.all(
      page.items.map((entry) => this.find(tenant, entry.clientId)),
    );
    return {
      items: found.filter((client) => client !== null),
      nextCursor: page.nextCursor,
    };
  }

  async find(tenant: CliTenant, clientId: string): Promise<ClientView | null> {
    const record = await this.storeOf(tenant).findClient(clientId);
    if (record === null || record.source !== "registered") return null;
    return {
      clientId: record.id,
      name: record.name,
      type: record.secretHash === undefined ? "public" : "confidential",
      redirectUris: record.redirectUris,
      createdAt: record.createdAt,
    };
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
    // The id is claimed in the index first (its unique index decides between
    // two creations of one id), then the client is written.
    const claimed =
      clientId !== "" &&
      !(await this.options.index.claim(tenant._id, {
        clientId,
        name: input.name,
        type: input.type,
        redirectUris: input.redirectUris,
      }));
    if (claimed) throw taken;
    const registered = await this.register(tenant, {
      name: input.name,
      redirectUris: input.redirectUris,
      type: input.type,
      clientId,
    }).catch(async (error) => {
      if (clientId !== "")
        await this.options.index.remove(tenant._id, clientId);
      throw error;
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

  /** `false` when it was not there. Grants it held lapse with their tokens. */
  async delete(tenant: CliTenant, clientId: string): Promise<boolean> {
    const store = this.storeOf(tenant);
    const record = await store.findClient(clientId);
    const removed =
      record !== null && record.source === "registered"
        ? await store.deleteClient(clientId)
        : false;
    await this.options.index.remove(tenant._id, clientId);
    return removed;
  }
}
