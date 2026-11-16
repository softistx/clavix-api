import type { Resolvers } from "@/generated/console/resolvers";
import type { Tenant } from "@/modules/tenants/tenants.model";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import { tenantArg } from "../ids";
import { oauthPolicyService as service } from "./wiring";

export const oauthPolicyGuards: Guards = {
  "Query.oauthPolicy": onTenant("view", tenantArg),
  "Mutation.updateOAuthPolicy": onTenant("edit", tenantArg),
};

const policyOf = (tenant: Tenant) => ({
  tenantId: tenant._id.toHexString(),
  par: { required: tenant.oauth.par.required },
  dpop: { required: tenant.oauth.dpop.required },
  version: tenant.version,
});

export const oauthPolicy: Resolvers = {
  Query: {
    oauthPolicy: async (_, { tenantId }) =>
      policyOf(await service.get(tenantId.toLowerCase())),
  },
  Mutation: {
    // Records its admin event once the change is stored, and on a repeat that
    // changed nothing too (the retry of a call whose record failed must not
    // leave the change with no event). Identifiers only.
    updateOAuthPolicy: async (_, { tenantId, input }, ctx) => {
      const tenant = await service.update(tenantId.toLowerCase(), {
        par: { required: input.par?.required ?? undefined },
        dpop: { required: input.dpop?.required ?? undefined },
      });
      // A tenant has one policy, so the tenant's id names it.
      const id = tenant._id.toHexString();
      await ctx.audit("oauthPolicy.update", {
        type: "oauthPolicy",
        id,
        tenantId: id,
      });
      return policyOf(tenant);
    },
  },
};

/** The audit action of each mutation (audit.spec.ts). */
export const oauthPolicyAudits: Audits = {
  "Mutation.updateOAuthPolicy": "oauthPolicy.update",
};
