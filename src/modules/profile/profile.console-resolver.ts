import { ObjectId } from "mongodb";
import { profilePoliciesService as service } from "@/config/profile";
import { liveTenant, tenantIdOf } from "@/console/modules/ids";
import type { Resolvers } from "@/generated/console/resolvers";
import { policyShape } from "./utils";

export { profileAudits, profileGuards } from "./profile.console-guards";

export const profile: Resolvers = {
  Query: {
    profilePolicy: async (_, { tenantId: given }, ctx) => {
      const tenantId = tenantIdOf(given);
      await liveTenant(ctx.directory, tenantId);
      return policyShape(await service.get(new ObjectId(tenantId)));
    },
  },
  Mutation: {
    updateProfilePolicy: async (
      _,
      { tenantId: given, locked, version },
      ctx,
    ) => {
      const tenantId = tenantIdOf(given);
      await liveTenant(ctx.directory, tenantId);
      const policy = await service.set(new ObjectId(tenantId), locked, version);
      await ctx.audit("profilePolicy.update", {
        type: "profilePolicy",
        id: tenantId,
        tenantId,
      });
      return policyShape(policy);
    },
  },
};
