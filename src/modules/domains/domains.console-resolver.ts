import { domainsService, tenantsService } from "@/config/tenancy";
import { catalogTenant } from "@/console/modules/catalog-support";
import type { Resolvers } from "@/generated/console/resolvers";
import { effectiveQuotas } from "@/modules/tenants";
import { refusing } from "./domains.console-support";
import { domainsKey, shape, target } from "./domains.utils";

export { domainsAudits, domainsGuards } from "./domains.console-guards";

export const domains: Resolvers = {
  Query: {
    domains: async (_, { tenantId }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      return (await domainsService.list(tenant._id)).map(shape);
    },
    domain: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const found = await domainsService.find(tenant._id, id);
      return found === undefined ? null : shape(found);
    },
  },
  Mutation: {
    addDomain: async (_, { tenantId, host }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const stored = await tenantsService.find(tenant._id.toHexString());
      const quota = stored === undefined ? 0 : effectiveQuotas(stored).domains;
      // The quota count and the insert are not atomic: one claim at a time
      // per tenant, across processes when there is a shared lock.
      const created = await ctx.exclusive(domainsKey(tenant), () =>
        refusing(() => domainsService.add(tenant._id, host, quota)),
      );
      await ctx.audit(
        "domain.add",
        target(tenant._id, created._id.toHexString()),
      );
      return shape(created);
    },
    verifyDomain: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const { domain, failure } = await refusing(() =>
        domainsService.verify(tenant._id, id),
      );
      await ctx.audit("domain.verify", target(tenant._id, id));
      return { domain: shape(domain), failure };
    },
    removeDomain: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const removed = await ctx.exclusive(domainsKey(tenant), () =>
        refusing(() => domainsService.remove(tenant._id, id)),
      );
      // Recorded on a repeat too (it may be the event the first run missed).
      // An id the trail cannot hold (empty, over 200) names no claim.
      if (id.length >= 1 && id.length <= 200) {
        await ctx.audit("domain.remove", target(tenant._id, id));
      }
      return removed;
    },
    setPrimaryDomain: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      // Two calls at once would each flip a different claim to primary and
      // then clear the other: one at a time per tenant.
      const updated = await ctx.exclusive(domainsKey(tenant), () =>
        refusing(() => domainsService.setPrimary(tenant._id, id)),
      );
      await ctx.audit("domain.setPrimary", target(tenant._id, id));
      return shape(updated);
    },
  },
};
