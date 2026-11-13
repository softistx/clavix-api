import { env } from "@/config/env";
import type { Resolvers } from "@/generated/console/resolvers";
import {
  isAvailable,
  type MethodType,
  methodsOf,
  type SocialProviderId,
} from "@/modules/sign-in-methods/sign-in.schema";
import { callbackUrlOf } from "@/modules/sign-in-methods/social";
import { issuerOf } from "@/modules/tenants/identity";
import type { Tenant } from "@/modules/tenants/tenants.model";
import { type Guards, onTenant } from "../../guard";
import { signInPolicyService as service } from "./wiring";

const tenantOf = (args: Record<string, unknown>) => String(args["tenantId"]);

export const signInMethodsGuards: Guards = {
  "Query.signInPolicy": onTenant("view", tenantOf),
  "Mutation.updateSignInMethods": onTenant("edit", tenantOf),
  "Mutation.setSocialProvider": onTenant("edit", tenantOf),
  "Mutation.removeSocialProvider": onTenant("edit", tenantOf),
};

const METHOD = {
  passkey: "PASSKEY",
  emailCode: "EMAIL_CODE",
  magicLink: "MAGIC_LINK",
  password: "PASSWORD",
} as const satisfies Record<MethodType, string>;

const KIND = {
  google: "GOOGLE",
  github: "GITHUB",
  microsoft: "MICROSOFT",
} as const satisfies Record<SocialProviderId, string>;

/** The stored name of a GraphQL enum value (`EMAIL_CODE` to `emailCode`). */
const storedOf = <K extends string, V extends string>(
  names: Record<K, V>,
  value: V,
): K => (Object.keys(names) as K[]).find((key) => names[key] === value) as K;

/** The policy as the console shows it: no secret, only that one is stored. */
function policyOf(tenant: Tenant) {
  const issuer = issuerOf(tenant.slug, {
    scheme: env.CLAVIX_PUBLIC_SCHEME,
    domain: env.CLAVIX_DOMAIN,
    port: env.CLAVIX_PUBLIC_PORT,
  });
  return {
    tenantId: tenant._id.toHexString(),
    methods: methodsOf(tenant.signIn).map(({ type, enabled }) => ({
      type: METHOD[type],
      enabled,
      available: isAvailable(type),
    })),
    social: tenant.signIn.social.map((entry) => ({
      provider: KIND[entry.provider],
      clientId: entry.clientId,
      hasSecret: true,
      enabled: entry.enabled,
      callbackUrl: callbackUrlOf(issuer, entry.provider),
    })),
    version: tenant.version,
  };
}

export const signInMethods: Resolvers = {
  Query: {
    signInPolicy: async (_, { tenantId }) =>
      policyOf(await service.get(tenantId)),
  },
  Mutation: {
    updateSignInMethods: async (_, { tenantId, methods }) =>
      policyOf(
        await service.updateMethods(
          tenantId,
          methods.map(({ type, enabled }) => ({
            type: storedOf(METHOD, type),
            enabled,
          })),
        ),
      ),
    setSocialProvider: async (_, { tenantId, input }) =>
      policyOf(
        await service.setSocial(tenantId, {
          provider: storedOf(KIND, input.provider),
          clientId: input.clientId ?? undefined,
          clientSecret: input.clientSecret ?? undefined,
          enabled: input.enabled ?? undefined,
        }),
      ),
    removeSocialProvider: async (_, { tenantId, provider }) =>
      policyOf(await service.removeSocial(tenantId, storedOf(KIND, provider))),
  },
};
