import type { ObjectId } from "mongodb";
import { domainsService, tenantsService } from "@/config/tenancy";
import type { Resolvers } from "@/generated/console/resolvers";
import type { DomainDoc, DomainError } from "@/modules/domains";
import { DomainError as DomainErrorClass, txtNameOf } from "@/modules/domains";
import { effectiveQuotas } from "@/modules/tenants";
import { fail } from "@/shared/errors";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import { catalogTenant } from "../catalog-support";
import { tenantArg } from "../ids";
import { refusal } from "../tenants/errors";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

export const domainsGuards: Guards = {
  "Query.domains": view,
  "Query.domain": view,
  "Mutation.addDomain": edit,
  "Mutation.verifyDomain": edit,
  "Mutation.removeDomain": edit,
  "Mutation.setPrimaryDomain": edit,
};

export const domainsAudits: Audits = {
  "Mutation.addDomain": "domain.add",
  "Mutation.verifyDomain": "domain.verify",
  "Mutation.removeDomain": "domain.remove",
  "Mutation.setPrimaryDomain": "domain.setPrimary",
};

const STATUS = {
  BAD_USER_INPUT: 400,
  NOT_FOUND: 404,
  DOMAIN_TAKEN: 409,
  DOMAIN_PRIMARY: 409,
  DOMAIN_NOT_VERIFIED: 409,
  VERIFY_COOLDOWN: 429,
} as const;

// The service's refusals as the contract's GraphQL errors (the quota one too).
async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof DomainErrorClass) {
      const failure: DomainError = error;
      throw fail(failure.code, failure.message, {
        status: STATUS[failure.code],
        retryAfter: failure.retryAfter,
        field: failure.code === "BAD_USER_INPUT" ? "host" : undefined,
      });
    }
    throw refusal(error);
  }
}

// What an admin event names: the claim's id and its tenant. Never the token.
const target = (tenantId: ObjectId, id: string) => ({
  type: "domain",
  id,
  tenantId: tenantId.toHexString(),
});

/** The `Exclusive` key of a tenant's domain claims. */
const domainsKey = (tenant: { _id: ObjectId }) =>
  `console:domains:${tenant._id.toHexString()}`;

const shape = (doc: DomainDoc) => ({
  id: doc._id.toHexString(),
  host: doc.host,
  status: doc.status.toUpperCase() as "PENDING" | "VERIFIED" | "UNVERIFIED",
  txtRecord: { name: txtNameOf(doc.host), value: doc.txtToken },
  primary: doc.primary,
  verifiedAt: doc.verifiedAt,
  checkedAt: doc.checkedAt,
  createdAt: doc.createdAt,
});

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
