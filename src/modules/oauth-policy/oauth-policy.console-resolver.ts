import { oauthPolicyService as service } from "@/config/oauth-policy";
import type { Resolvers } from "@/generated/console/resolvers";
import { MODE, policyOf } from "./oauth-policy.utils";

export {
  oauthPolicyAudits,
  oauthPolicyGuards,
} from "./oauth-policy.console-guards";

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
        agents: input.agents && {
          dynamic: input.agents.dynamic
            ? MODE[input.agents.dynamic]
            : undefined,
          redirectUris: input.agents.redirectUris ?? undefined,
          metadataDocuments: input.agents.metadataDocuments ?? undefined,
          allowHosts: input.agents.allowHosts ?? undefined,
        },
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
