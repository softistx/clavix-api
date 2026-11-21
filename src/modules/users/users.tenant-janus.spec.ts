import { describe, expect, test } from "bun:test";
import { oauthDb } from "@/config/oauth-db";
import { signInPolicySchema } from "@/modules/sign-in-methods";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { quietJanus } from "~/ports";
import { socialOf } from "./users.tenant-janus";

const tenant: ResolvedTenant = {
  tenantId: "65f0000000000000000000aa",
  slug: "acme",
  name: "Acme",
  signUp: false,
  status: "active",
  issuer: "https://acme.clavix.test",
  slugIssuer: "https://acme.clavix.test",
  relatedOrigins: ["https://auth.acme.com"],
  plan: "free",
  partition: "65f0000000000000000000aa",
  version: 1,
  oauth: {
    par: { required: false },
    dpop: { required: false },
    agents: {
      dynamic: "off",
      redirectUris: [],
      metadataDocuments: false,
      allowHosts: [],
    },
  },
  signIn: signInPolicySchema.parse(undefined),
};

describe("buildTenantJanus", () => {
  test("a tenant's instance has the passkey and step-up surfaces, and its social API", () => {
    const auth = quietJanus(oauthDb, tenant);
    expect(typeof auth.stepUp.confirmPasskey).toBe("function");
    expect(typeof auth.secondFactor.passkeyOptions).toBe("function");
    expect(socialOf(auth)).toBe(auth as never);
  });
});

describe("socialOf", () => {
  test("the instance when it has a social API, else null", () => {
    const withSocial = { social: {} } as unknown as Parameters<
      typeof socialOf
    >[0];
    const without = {} as unknown as Parameters<typeof socialOf>[0];
    expect(socialOf(withSocial)).toBe(withSocial as never);
    expect(socialOf(without)).toBeNull();
  });
});
