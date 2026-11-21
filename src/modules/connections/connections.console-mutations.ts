import { connectionsService as connections } from "@/config/connections";
import { tenantsService } from "@/config/tenancy";
import { catalogTenant } from "@/console/modules/catalog-support";
import type { Resolvers } from "@/generated/console/resolvers";
import { issuerFor } from "@/modules/sign-in-methods/sign-in-methods.console-support";
import { effectiveQuotas } from "@/modules/tenants";
import { createOf, patchOf, refusing } from "./connections.console-support";
import {
  connectionShape,
  connectionsKey,
  connectionTarget,
} from "./connections.utils";

export const connectionMutations: NonNullable<Resolvers["Mutation"]> = {
  createConnection: async (_, { tenantId, input }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const stored = await tenantsService.find(tenant._id.toHexString());
    const quota =
      stored === undefined ? 0 : effectiveQuotas(stored).connections;
    const created = await ctx.exclusive(connectionsKey(tenant), () =>
      refusing(() =>
        connections.create(tenant._id.toHexString(), createOf(input), quota),
      ),
    );
    await ctx.audit(
      "connection.create",
      connectionTarget(tenant._id, created.connectionId),
    );
    return connectionShape(created, await issuerFor(tenant));
  },
  updateConnection: async (_, { tenantId, id, input }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const updated = await ctx.exclusive(connectionsKey(tenant), () =>
      refusing(() =>
        connections.update(tenant._id.toHexString(), id, patchOf(input)),
      ),
    );
    await ctx.audit("connection.update", connectionTarget(tenant._id, id));
    return connectionShape(updated, await issuerFor(tenant));
  },
  setConnectionSecret: async (_, { tenantId, id, clientSecret }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const updated = await ctx.exclusive(connectionsKey(tenant), () =>
      refusing(() =>
        connections.setSecret(tenant._id.toHexString(), id, clientSecret),
      ),
    );
    await ctx.audit("connection.setSecret", connectionTarget(tenant._id, id));
    return connectionShape(updated, await issuerFor(tenant));
  },
  deleteConnection: async (_, { tenantId, id }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const removed = await ctx.exclusive(connectionsKey(tenant), () =>
      refusing(() => connections.delete(tenant._id.toHexString(), id)),
    );
    // Recorded on a repeat too (it may be the event the first run missed).
    await ctx.audit("connection.delete", connectionTarget(tenant._id, id));
    return removed;
  },
  addConnectionDomain: async (_, { tenantId, id, domain }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const updated = await ctx.exclusive(connectionsKey(tenant), () =>
      refusing(() =>
        connections.addDomain(tenant._id.toHexString(), id, domain),
      ),
    );
    await ctx.audit("connection.addDomain", connectionTarget(tenant._id, id));
    return connectionShape(updated, await issuerFor(tenant));
  },
  verifyConnectionDomain: async (_, { tenantId, id, domain }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const checked = await ctx.exclusive(connectionsKey(tenant), () =>
      refusing(() =>
        connections.verifyDomain(tenant._id.toHexString(), id, domain),
      ),
    );
    await ctx.audit(
      "connection.verifyDomain",
      connectionTarget(tenant._id, id),
    );
    return {
      connection: connectionShape(checked.connection, await issuerFor(tenant)),
      verified: checked.verified,
    };
  },
  removeConnectionDomain: async (_, { tenantId, id, domain }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const updated = await ctx.exclusive(connectionsKey(tenant), () =>
      refusing(() =>
        connections.removeDomain(tenant._id.toHexString(), id, domain),
      ),
    );
    await ctx.audit(
      "connection.removeDomain",
      connectionTarget(tenant._id, id),
    );
    return connectionShape(updated, await issuerFor(tenant));
  },
};
