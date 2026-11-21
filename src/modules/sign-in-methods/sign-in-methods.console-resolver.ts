import { signInPolicyService as service } from "@/config/sign-in-policy";
import type { Resolvers } from "@/generated/console/resolvers";
import { policyOf } from "./sign-in-methods.console-support";
import {
  CONSOLE_KIND,
  CONSOLE_METHOD,
  CONSOLE_MODE,
  storedOf,
} from "./sign-in-methods.utils";

export {
  signInMethodsAudits,
  signInMethodsGuards,
} from "./sign-in-methods.console-guards";

export const signInMethods: Resolvers = {
  Query: {
    signInPolicy: async (_, { tenantId }) =>
      await policyOf(await service.get(tenantId.toLowerCase())),
  },
  Mutation: {
    // Each records its admin event once the change is stored, and on a repeat
    // that changed nothing too (the retry of a call whose record failed must
    // not leave the change with no event). Identifiers only, never a secret.
    updateSignInMethods: async (_, { tenantId, methods }, ctx) => {
      const tenant = await service.updateMethods(
        tenantId.toLowerCase(),
        methods.map(({ type, enabled }) => ({
          type: storedOf(CONSOLE_METHOD, type),
          enabled,
        })),
      );
      // A tenant has one policy, so the tenant's id names it: the stored id,
      // not the argument as the caller spelled it.
      const id = tenant._id.toHexString();
      await ctx.audit("signInPolicy.update", {
        type: "signInPolicy",
        id,
        tenantId: id,
      });
      return await policyOf(tenant);
    },
    setSocialProvider: async (_, { tenantId, input }, ctx) => {
      const provider = storedOf(CONSOLE_KIND, input.provider);
      const tenant = await service.setSocial(tenantId.toLowerCase(), {
        provider,
        clientId: input.clientId ?? undefined,
        clientSecret: input.clientSecret ?? undefined,
        enabled: input.enabled ?? undefined,
      });
      await ctx.audit("socialProvider.set", {
        type: "socialProvider",
        id: provider,
        tenantId: tenant._id.toHexString(),
      });
      return await policyOf(tenant);
    },
    updateMfaPolicy: async (_, { tenantId, input }, ctx) => {
      const tenant = await service.updateMfa(tenantId.toLowerCase(), {
        ...(input.mode === null || input.mode === undefined
          ? {}
          : { mode: storedOf(CONSOLE_MODE, input.mode) }),
        ...(input.totp === null || input.totp === undefined
          ? {}
          : { totp: input.totp }),
      });
      const id = tenant._id.toHexString();
      await ctx.audit("mfaPolicy.update", {
        type: "mfaPolicy",
        id,
        tenantId: id,
      });
      return await policyOf(tenant);
    },
    removeSocialProvider: async (_, { tenantId, provider: kind }, ctx) => {
      const provider = storedOf(CONSOLE_KIND, kind);
      const tenant = await service.removeSocial(
        tenantId.toLowerCase(),
        provider,
      );
      await ctx.audit("socialProvider.remove", {
        type: "socialProvider",
        id: provider,
        tenantId: tenant._id.toHexString(),
      });
      return await policyOf(tenant);
    },
  },
};
