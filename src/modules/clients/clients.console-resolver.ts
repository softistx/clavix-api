import { clientsService } from "@/config/clients";
import { resourcesService } from "@/config/resources";
import { catalogTenant, refusing } from "@/console/modules/catalog-support";
import { pageSize } from "@/console/modules/ids";
import { keepConsoleClient } from "@/console/modules/reserved";
import type { Resolvers } from "@/generated/console/resolvers";
import { CatalogError } from "@/modules/resources";
import { fail } from "@/shared/errors";
import { assertClientQuota } from "./clients.console-support";
import {
  clientsKey,
  isClientId,
  kindsOf,
  settingsOf,
  shape,
  target,
} from "./clients.utils";

/** Replaces a client's token exchange rules (RFC 8693), under the tenant's client lock. */
const setClientTokenExchange: NonNullable<
  NonNullable<Resolvers["Mutation"]>["setClientTokenExchange"]
> = async (_, { tenantId, id, input }, ctx) => {
  const tenant = await catalogTenant(ctx, tenantId);
  const listed = input.subjectClients?.length ?? 0;
  const agents = input.subjectAgents === true;
  if (input.anySubjectClient === true ? listed > 0 : listed === 0 && !agents) {
    await refusing(async () => {
      throw new CatalogError(
        "BAD_USER_INPUT",
        input.anySubjectClient === true
          ? "Give subjectClients or anySubjectClient, not both"
          : "Give the clients whose tokens may be exchanged, subjectAgents, or anySubjectClient",
      );
    });
  }
  // Under the tenant's client lock: a delete in between would leave rules
  // of a client that is gone.
  const rules = await ctx.exclusive(clientsKey(tenant), () =>
    refusing(async () => {
      keepConsoleClient(tenant, id);
      const resources = await resourcesService.listResources(tenant._id);
      return clientsService.setTokenExchange(
        tenant,
        id,
        {
          targetResources: input.targetResources,
          subjectClients:
            input.anySubjectClient === true
              ? "any"
              : (input.subjectClients ?? []),
          subjectAgents: agents,
        },
        resources.map((resource) => resource.uri),
      );
    }),
  );
  await ctx.audit("client.tokenExchange.set", target(tenant, id));
  const client = await clientsService.find(tenant, id);
  if (client === null)
    throw fail("NOT_FOUND", "No such client", { status: 404 });
  return shape(client, rules);
};

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
