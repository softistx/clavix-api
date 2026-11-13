import { GraphQLError } from "graphql";
import type { ObjectId } from "mongodb";
import { domainStore, tenantAdmin } from "@/config/tenancy";
import type { Resolvers } from "@/generated/console/resolvers";
import { txtNameOf } from "@/modules/domains/domain-host";
import type { DomainError } from "@/modules/domains/domains.errors";
import { DomainError as DomainErrorClass } from "@/modules/domains/domains.errors";
import type { DomainDoc } from "@/modules/domains/domains.service";
import { effectiveQuotas } from "@/modules/tenants/plan.schema";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import { activeTenant, tenantArg } from "../catalog-support";
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
} as const;

// The service's refusals as the contract's GraphQL errors (the quota one too).
async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof DomainErrorClass) {
      const failure: DomainError = error;
      throw new GraphQLError(failure.message, {
        extensions: {
          code: failure.code,
          http: { status: STATUS[failure.code] },
          ...(failure.code === "BAD_USER_INPUT" ? { field: "host" } : {}),
        },
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
      const tenant = await activeTenant(ctx, tenantId);
      return (await domainStore.list(tenant._id)).map(shape);
    },
    domain: async (_, { tenantId, id }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const found = await domainStore.find(tenant._id, id);
      return found === undefined ? null : shape(found);
    },
  },
  Mutation: {
    addDomain: async (_, { tenantId, host }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const stored = await tenantAdmin.find(tenantId);
      const quota = stored === undefined ? 0 : effectiveQuotas(stored).domains;
      const created = await refusing(() =>
        domainStore.add(tenant._id, host, quota),
      );
      await ctx.audit(
        "domain.add",
        target(tenant._id, created._id.toHexString()),
      );
      return shape(created);
    },
    verifyDomain: async (_, { tenantId, id }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const { domain, failure } = await refusing(() =>
        domainStore.verify(tenant._id, id),
      );
      await ctx.audit("domain.verify", target(tenant._id, id));
      return { domain: shape(domain), failure };
    },
    removeDomain: async (_, { tenantId, id }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const removed = await refusing(() => domainStore.remove(tenant._id, id));
      if (removed) await ctx.audit("domain.remove", target(tenant._id, id));
      return removed;
    },
    setPrimaryDomain: async (_, { tenantId, id }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const updated = await refusing(() =>
        domainStore.setPrimary(tenant._id, id),
      );
      await ctx.audit("domain.setPrimary", target(tenant._id, id));
      return shape(updated);
    },
  },
};
