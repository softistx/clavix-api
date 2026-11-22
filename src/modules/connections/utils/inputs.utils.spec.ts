import { describe, expect, test } from "bun:test";
import { checkOf, claimsIn, createOf, patchOf } from "./inputs.utils";

describe("claimsIn", () => {
  test("none given stays none, strings are kept", () => {
    expect(claimsIn(undefined)).toBeUndefined();
    expect(claimsIn(null)).toBeUndefined();
    expect(claimsIn({ email: "mail", name: null })).toEqual({ email: "mail" });
  });
});

describe("checkOf", () => {
  test("maps the console enums to the stored names, with the defaults", () => {
    const out = checkOf({
      id: "acme",
      issuer: "https://idp.test",
      clientId: "c",
      clientSecret: "s",
    });
    expect(out).toMatchObject({
      connectionId: "acme",
      clientAuthentication: null,
      idTokenSignedResponseAlg: null,
      scopes: null,
      emailTrust: "claimAndDomain",
      claims: {},
      domains: [],
      revision: 1,
    });
    expect(
      checkOf({
        id: "acme",
        issuer: "https://idp.test",
        clientId: "c",
        clientSecret: "s",
        clientAuthentication: "BASIC",
        emailTrust: "DOMAIN",
        claims: { email: "mail" },
      }),
    ).toMatchObject({
      clientAuthentication: "basic",
      emailTrust: "domain",
      claims: { email: "mail" },
    });
  });
});

describe("createOf", () => {
  test("maps the enums and turns null flags into absent ones", () => {
    const out = createOf({
      id: "acme",
      name: "Acme",
      issuer: "https://idp.test",
      clientId: "c",
      clientSecret: "s",
      clientAuthentication: "POST",
      emailTrust: "CLAIM_AND_DOMAIN",
      requireSso: null,
      jit: false,
    });
    expect(out.clientAuthentication).toBe("post");
    expect(out.emailTrust).toBe("claimAndDomain");
    expect(out.requireSso).toBeUndefined();
    expect(out.jit).toBe(false);
    expect(out.claims).toBeUndefined();
  });
});

describe("patchOf", () => {
  test("keeps only what the caller sent, null clearing an optional field", () => {
    expect(patchOf({})).toEqual({});
    expect(
      patchOf({
        name: "N",
        clientAuthentication: null,
        scopes: null,
        emailTrust: "DOMAIN",
        enabled: false,
        issuer: null,
      }),
    ).toEqual({
      name: "N",
      clientAuthentication: null,
      scopes: null,
      emailTrust: "domain",
      enabled: false,
    });
    expect(patchOf({ clientAuthentication: "BASIC" })).toEqual({
      clientAuthentication: "basic",
    });
  });
});
