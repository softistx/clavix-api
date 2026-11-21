import { describe, expect, test } from "bun:test";
import { signInPolicySchema } from "@/modules/sign-in-methods";
import { resolvedTenant } from "./resolved-tenant";

const entry = {
  tenantId: "65f0000000000000000000aa",
  slug: "acme",
  name: "Acme",
  signUp: false,
  status: "active" as const,
  issuer: "https://auth.acme.com",
  slugIssuer: "https://acme.clavix.test",
  partition: "65f0000000000000000000aa",
  version: 1,
  signIn: signInPolicySchema.parse(undefined),
};

describe("resolvedTenant", () => {
  test("carries the slug issuer beside the issuer", () => {
    expect(resolvedTenant.parse(entry).slugIssuer).toBe(
      "https://acme.clavix.test",
    );
  });

  test("an entry cached before the OAuth policy reads every requirement off", () => {
    expect(resolvedTenant.parse(entry).oauth).toEqual({
      par: { required: false },
      dpop: { required: false },
      agents: {
        dynamic: "off",
        redirectUris: [],
        metadataDocuments: false,
        allowHosts: [],
      },
    });
    expect(resolvedTenant.parse(entry).oauth.agents.dynamic).toBe("off");
    expect(
      resolvedTenant.parse({ ...entry, oauth: { par: { required: true } } })
        .oauth,
    ).toMatchObject({ par: { required: true }, dpop: { required: false } });
  });

  test("an entry cached before custom domains (no slugIssuer) is refused, so the cache reads it as a miss", () => {
    const { slugIssuer: _drop, ...old } = entry;
    expect(resolvedTenant.safeParse(old).success).toBe(false);
  });
});
