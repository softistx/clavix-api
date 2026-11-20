import { denial } from "@softistx/janus-graphql";
import { clientsService } from "@/config/clients";
import { tenantAdmin } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import type { Resolvers } from "@/generated/console/resolvers";
import { assertWithinQuota, QuotaExceededError } from "@/modules/usage/quota";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import { catalogTenant, refusing } from "../catalog-support";
import { tenantArg } from "../ids";
import { keepConsoleClient } from "../reserved";
import { refusal } from "../tenants/errors";
import { clientsKey, grantsOf, kindsOf, shape, target } from "./shape";
import { setClientTokenExchange } from "./token-exchange";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

export const clientsGuards: Guards = {
  "Query.clients": view,
  "Query.client": view,
  "Mutation.createClient": edit,
  "Mutation.updateClient": edit,
  "Mutation.rotateClientSecret": edit,
  "Mutation.setClientTokenExchange": edit,
  "Mutation.deleteClient": edit,
};

export const clientsAudits: Audits = {
  "Mutation.createClient": "client.create",
  "Mutation.updateClient": "client.update",
  "Mutation.rotateClientSecret": "client.rotateSecret",
  "Mutation.setClientTokenExchange": "client.tokenExchange.set",
  "Mutation.deleteClient": "client.delete",
};

const MAX_PAGE = 100;

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
    clients: async (_, { tenantId, q, kind, after, first }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const [page, totalCount] = await refusing(() =>
        Promise.all([
          clientsService.list(tenant, {
            after: after ?? null,
            limit: Math.min(Math.max(first ?? 25, 1), MAX_PAGE),
            q: q ?? undefined,
            kinds: kindsOf(kind),
          }),
          clientsService.count(tenant, {
            q: q ?? undefined,
            kinds: kindsOf(kind),
          }),
        ]),
      );
      const rules = await clientsService.tokenExchangeOf(
        tenant,
        page.items.map((item) => item.clientId),
      );
      return {
        items: page.items.map((item) => shape(item, rules.get(item.clientId))),
        nextCursor: page.nextCursor,
        totalCount,
      };
    },
    client: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const found = await clientsService.find(tenant, id, { agents: true });
      return found === null
        ? null
        : shape(found, await clientsService.tokenExchange(tenant, id));
    },
  },
  Mutation: {
    createClient: async (_, { tenantId, input }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      // The existence check and the write of `create`, and the quota count,
      // are not atomic (the janus store has no insert-only write): one create
      // at a time per tenant, across processes when there is a shared lock.
      const wanted = {
        name: input.name,
        type: input.type === "CONFIDENTIAL" ? "confidential" : "public",
        redirectUris: input.redirectUris ?? [],
        clientId: input.clientId ?? undefined,
        grants: grantsOf(input.grantTypes),
        requirePar: input.requirePushedAuthorizationRequests ?? undefined,
        dpopBound: input.dpopBoundAccessTokens ?? undefined,
        detailTypes: input.authorizationDetailsTypes ?? undefined,
        allowedScopes: input.allowedScopes ?? undefined,
        defaultScopes: input.defaultScopes ?? undefined,
      } as const;
      const created = await ctx.exclusive(clientsKey(tenant), () =>
        refusing(async () => {
          // A repeat of a call whose record failed adds no client, so it
          // needs no quota; the service returns the stored one, no secret.
          if (!(await clientsService.matches(tenant, wanted))) {
            await assertClientQuota(tenant);
          }
          return clientsService.create(tenant, wanted);
        }),
      );
      await ctx.audit("client.create", target(tenant, created.client.clientId));
      return {
        client: shape(created.client),
        clientSecret: created.clientSecret,
      };
    },
    updateClient: async (_, { tenantId, id, input }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      // Under the tenant's lock, as `create` and `delete`: the service reads
      // the client, then writes it back (the store upserts), so a delete in
      // between would bring it back. Serialized, the update of a client that
      // is gone is `NOT_FOUND`, never a new client.
      const updated = await ctx.exclusive(clientsKey(tenant), () =>
        refusing(() => {
          keepConsoleClient(tenant, id);
          return clientsService.update(tenant, id, {
            name: input.name ?? undefined,
            redirectUris: input.redirectUris ?? undefined,
            grants: grantsOf(input.grantTypes),
            requirePar: input.requirePushedAuthorizationRequests ?? undefined,
            dpopBound: input.dpopBoundAccessTokens ?? undefined,
            detailTypes: input.authorizationDetailsTypes ?? undefined,
            allowedScopes: input.allowedScopes ?? undefined,
            defaultScopes: input.defaultScopes ?? undefined,
          });
        }),
      );
      await ctx.audit("client.update", target(tenant, updated.clientId));
      return shape(updated, await clientsService.tokenExchange(tenant, id));
    },
    setClientTokenExchange,
    rotateClientSecret: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const rotated = await ctx.exclusive(clientsKey(tenant), () =>
        refusing(() => {
          keepConsoleClient(tenant, id);
          return clientsService.rotateSecret(tenant, id);
        }),
      );
      await ctx.audit(
        "client.rotateSecret",
        target(tenant, rotated.client.clientId),
      );
      return {
        client: shape(
          rotated.client,
          await clientsService.tokenExchange(tenant, id),
        ),
        clientSecret: rotated.clientSecret,
      };
    },
    deleteClient: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const { removed, unmanaged } = await ctx.exclusive(
        clientsKey(tenant),
        () =>
          refusing(async () => {
            keepConsoleClient(tenant, id);
            return clientsService.delete(tenant, id);
          }),
      );
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
