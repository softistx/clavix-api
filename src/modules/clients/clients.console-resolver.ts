import { clientsService } from "@/config/clients";
import { catalogTenant, refusing } from "@/console/modules/catalog-support";
import { pageSize } from "@/console/modules/ids";
import { keepConsoleClient } from "@/console/modules/reserved";
import type { Resolvers } from "@/generated/console/resolvers";
import { assertClientQuota } from "./clients.console-support";
import { setClientTokenExchange } from "./clients.console-token-exchange";
import {
  clientsKey,
  isClientId,
  kindsOf,
  settingsOf,
  shape,
  target,
} from "./clients.utils";

export { clientsAudits, clientsGuards } from "./clients.console-guards";

export const clients: Resolvers = {
  Query: {
    clients: async (_, { tenantId, q, kind, after, first }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const [page, totalCount] = await refusing(() =>
        Promise.all([
          clientsService.list(tenant, {
            after: after ?? null,
            limit: pageSize(first),
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
        ...settingsOf(input),
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
            ...settingsOf(input),
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
      if (removed || (isClientId(id) && !unmanaged)) {
        await ctx.audit("client.delete", target(tenant, id));
      }
      return removed;
    },
  },
};
