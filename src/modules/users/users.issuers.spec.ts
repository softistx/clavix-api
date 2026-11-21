import { describe, expect, test } from "bun:test";
import { oauthDb } from "@/config/oauth-db";
import { signInPolicySchema } from "@/modules/sign-in-methods";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { quietUsers } from "~/ports";
import { createTenantJanusIssuers } from "./users.issuers";

const base: ResolvedTenant = {
  tenantId: "65f0000000000000000000aa",
  slug: "acme",
  name: "Acme",
  signUp: false,
  status: "active",
  issuer: "https://acme.clavix.test",
  slugIssuer: "https://acme.clavix.test",
  relatedOrigins: [],
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

const request = new Request("https://acme.clavix.test/graphql");

/** Issuers over a resolver whose tenant the spec changes between calls. */
const issuersOver = (current: { tenant: ResolvedTenant | null }) =>
  createTenantJanusIssuers({
    ...quietUsers,
    resolver: { resolveRequest: async () => current.tenant },
    db: oauthDb,
    log: () => {},
  });

describe("createTenantJanusIssuers", () => {
  test("a host that resolves to no tenant has no instance", async () => {
    expect(await issuersOver({ tenant: null }).forRequest(request)).toBeNull();
  });

  test("the instance is kept while the tenant is unchanged", async () => {
    const issuers = issuersOver({ tenant: base });
    const first = await issuers.forRequest(request);
    expect(first).not.toBeNull();
    expect(await issuers.forRequest(request)).toBe(first);
  });

  test("a new version of the tenant rebuilds it", async () => {
    const current = { tenant: base as ResolvedTenant | null };
    const issuers = issuersOver(current);
    const first = await issuers.forRequest(request);
    current.tenant = { ...base, version: 2 };
    expect(await issuers.forRequest(request)).not.toBe(first);
  });

  test("a verified or removed custom domain rebuilds it", async () => {
    const current = { tenant: base as ResolvedTenant | null };
    const issuers = issuersOver(current);
    const first = await issuers.forRequest(request);
    current.tenant = { ...base, relatedOrigins: ["https://auth.acme.com"] };
    expect(await issuers.forRequest(request)).not.toBe(first);
  });

  test("a new tenant under a purged tenant's slug does not get the old instance", async () => {
    const current = { tenant: base as ResolvedTenant | null };
    const issuers = issuersOver(current);
    const first = await issuers.forRequest(request);
    current.tenant = { ...base, tenantId: "65f0000000000000000000bb" };
    expect(await issuers.forRequest(request)).not.toBe(first);
  });
});
