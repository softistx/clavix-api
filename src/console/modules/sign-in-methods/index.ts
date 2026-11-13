import { env } from "@/config/env";
import { tenantResolver } from "@/config/tenancy";
import type { Resolvers } from "@/generated/console/resolvers";
import {
  isAvailable,
  type MethodType,
  methodsOf,
  type SocialProviderId,
} from "@/modules/sign-in-methods/sign-in.schema";
import { callbackUrlOf } from "@/modules/sign-in-methods/social";
import { hostOf, issuerOf } from "@/modules/tenants/identity";
import type { Tenant } from "@/modules/tenants/tenants.model";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import { tenantArg } from "../ids";
import { signInPolicyService as service } from "./wiring";

export const signInMethodsGuards: Guards = {
  "Query.signInPolicy": onTenant("view", tenantArg),
  "Mutation.updateSignInMethods": onTenant("edit", tenantArg),
  "Mutation.setSocialProvider": onTenant("edit", tenantArg),
  "Mutation.removeSocialProvider": onTenant("edit", tenantArg),
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

/**
 * The stored name of a GraphQL enum value (`EMAIL_CODE` to `emailCode`). The
 * schema already limits the value to the enum, so a miss is a mismatch between
 * the SDL and this map: it fails loudly instead of storing `undefined`.
 */
const storedOf = <K extends string, V extends string>(
  names: Record<K, V>,
  value: V,
): K => {
  const key = (Object.keys(names) as K[]).find((k) => names[k] === value);
  if (key === undefined) {
    throw new Error(`No stored name for the enum value "${String(value)}"`);
  }
  return key;
};

async function issuerFor(tenant: Tenant) {
  const resolved = await tenantResolver.resolveHost(
    hostOf(tenant.slug, env.CLAVIX_DOMAIN),
  );
  return (
    resolved?.issuer ??
    issuerOf(tenant.slug, {
      scheme: env.CLAVIX_PUBLIC_SCHEME,
      domain: env.CLAVIX_DOMAIN,
      port: env.CLAVIX_PUBLIC_PORT,
    })
  );
}

/** The policy as the console shows it: no secret, only that one is stored. */
async function policyOf(tenant: Tenant) {
  // The issuer the runtime uses: the primary custom domain when there is one,
  // so the redirect URI shown is the one the callback really answers on.
  const issuer = await issuerFor(tenant);
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
          type: storedOf(METHOD, type),
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
      const provider = storedOf(KIND, input.provider);
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
    removeSocialProvider: async (_, { tenantId, provider: kind }, ctx) => {
      const provider = storedOf(KIND, kind);
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

/** The audit action of each mutation (audit.spec.ts). */
export const signInMethodsAudits: Audits = {
  "Mutation.updateSignInMethods": "signInPolicy.update",
  "Mutation.setSocialProvider": "socialProvider.set",
  "Mutation.removeSocialProvider": "socialProvider.remove",
};
