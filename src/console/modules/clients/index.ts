import { denial } from "@softistx/janus-graphql";
import { clientsService } from "@/config/clients";
import { tenantAdmin } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import type { Resolvers } from "@/generated/console/resolvers";
import { assertWithinQuota, QuotaExceededError } from "@/modules/usage/quota";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import { activeTenant, refusing, tenantArg } from "../catalog-support";
import { keepConsoleClient } from "../reserved";
import { refusal } from "../tenants/errors";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

export const clientsGuards: Guards = {
  "Query.clients": view,
  "Query.client": view,
  "Mutation.createClient": edit,
  "Mutation.updateClient": edit,
  "Mutation.rotateClientSecret": edit,
  "Mutation.deleteClient": edit,
};

export const clientsAudits: Audits = {
  "Mutation.createClient": "client.create",
  "Mutation.updateClient": "client.update",
  "Mutation.rotateClientSecret": "client.rotateSecret",
  "Mutation.deleteClient": "client.delete",
};

// What an admin event names: the client's id and its tenant, never its secret.
const target = (tenant: { _id: { toHexString(): string } }, id: string) => ({
  type: "client",
  id,
  tenantId: tenant._id.toHexString(),
});

const TYPE = { public: "PUBLIC", confidential: "CONFIDENTIAL" } as const;

const GRANT = {
  authorization_code: "AUTHORIZATION_CODE",
  refresh_token: "REFRESH_TOKEN",
} as const;

const shape = (client: {
  clientId: string;
  name: string;
  type: "public" | "confidential";
  redirectUris: readonly string[];
  grantTypes: readonly ("authorization_code" | "refresh_token")[];
  createdAt: Date;
}) => ({
  id: client.clientId,
  name: client.name,
  type: TYPE[client.type],
  redirectUris: [...client.redirectUris],
  grantTypes: client.grantTypes.map((grant) => GRANT[grant]),
  createdAt: client.createdAt,
});

const MAX_PAGE = 100;

/** The `Exclusive` key of a tenant's client creations. */
const clientsKey = (tenant: { _id: { toHexString(): string } }) =>
  `console:clients:${tenant._id.toHexString()}`;

/** Clients are a hard quota: one more past the plan's is `QUOTA_EXCEEDED` (409). */
async function assertClientQuota(tenant: { _id: { toHexString(): string } }) {
  const id = tenant._id.toHexString();
  const doc = await tenantAdmin.find(id);
  if (doc === undefined) throw denial("NOT_FOUND", "No such tenant");
  try {
    assertWithinQuota(
      "clients",
      await usageService.count(id, "clients"),
      usageService.quotasOf(doc).clients,
    );
  } catch (error) {
    if (error instanceof QuotaExceededError) throw refusal(error);
    throw error;
  }
}
const CLIENT_ID = /^[a-z0-9-]{1,64}$/;

export const clients: Resolvers = {
  Query: {
    clients: async (_, { tenantId, q, after, first }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const page = await refusing(() =>
        clientsService.list(tenant, {
          after: after ?? null,
          limit: Math.min(Math.max(first ?? 25, 1), MAX_PAGE),
          q: q ?? undefined,
        }),
      );
      return {
        items: page.items.map(shape),
        nextCursor: page.nextCursor,
      };
    },
    client: async (_, { tenantId, id }, ctx) => {
      const found = await clientsService.find(
        await activeTenant(ctx, tenantId),
        id,
      );
      return found === null ? null : shape(found);
    },
  },
  Mutation: {
    createClient: async (_, { tenantId, input }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      // The existence check and the write of `create`, and the quota count,
      // are not atomic (the janus store has no insert-only write): one create
      // at a time per tenant, across processes when there is a shared lock.
      const created = await ctx.exclusive(clientsKey(tenant), () =>
        refusing(async () => {
          await assertClientQuota(tenant);
          return clientsService.create(tenant, {
            name: input.name,
            type: input.type === "CONFIDENTIAL" ? "confidential" : "public",
            redirectUris: input.redirectUris,
            clientId: input.clientId ?? undefined,
          });
        }),
      );
      await ctx.audit("client.create", target(tenant, created.client.clientId));
      return {
        client: shape(created.client),
        clientSecret: created.clientSecret,
      };
    },
    updateClient: async (_, { tenantId, id, input }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const updated = await refusing(() => {
        keepConsoleClient(tenant, id);
        return clientsService.update(tenant, id, {
          name: input.name ?? undefined,
          redirectUris: input.redirectUris ?? undefined,
        });
      });
      await ctx.audit("client.update", target(tenant, updated.clientId));
      return shape(updated);
    },
    rotateClientSecret: async (_, { tenantId, id }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const rotated = await refusing(() => {
        keepConsoleClient(tenant, id);
        return clientsService.rotateSecret(tenant, id);
      });
      await ctx.audit(
        "client.rotateSecret",
        target(tenant, rotated.client.clientId),
      );
      return {
        client: shape(rotated.client),
        clientSecret: rotated.clientSecret,
      };
    },
    deleteClient: async (_, { tenantId, id }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      let unmanaged = false;
      const removed = await refusing(async () => {
        keepConsoleClient(tenant, id);
        unmanaged = await clientsService.isUnmanaged(tenant, id);
        return clientsService.delete(tenant, id);
      });
      // Recorded on a repeat too (it may be the event the first run missed);
      // an id no client can have names nothing to record, and neither does a
      // record that is not a registered client: it was left untouched, so
      // there is no change to put on the trail.
      if (removed || (CLIENT_ID.test(id) && !unmanaged)) {
        await ctx.audit("client.delete", target(tenant, id));
      }
      return removed;
    },
  },
};
