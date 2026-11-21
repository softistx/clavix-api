import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { sealedUnder } from "~/webhook-docs";
import { type ConnectionDoc, connections } from "./connections.model";
import {
  algorithmOf,
  claimsOf,
  contextOf,
  nextOf,
  normalDomain,
  txtNameOf,
} from "./connections.utils";

const _id = new ObjectId();
const stamp = new Date("2026-01-01T00:00:00Z");
const current: ConnectionDoc = {
  ...connections.schema.parse({
    _id,
    tenantId: new ObjectId(),
    connectionId: "acme",
    name: "Acme",
    issuer: "https://idp.test",
    clientId: "client",
    secret: sealedUnder("k"),
    clientAuthentication: "basic",
    idTokenSignedResponseAlg: null,
    scopes: null,
    emailTrust: "domain",
    claims: { email: "mail" },
    upstreamMfa: { acr: "mfa" },
    createdAt: stamp,
    updatedAt: stamp,
  }),
  id: _id.toHexString(),
};

describe("connections utils", () => {
  test("the TXT record sits under _clavix-sso", () => {
    expect(txtNameOf("acme.test")).toBe("_clavix-sso.acme.test");
  });

  test("a domain is trimmed and lower-cased", () => {
    expect(normalDomain("  ACME.Test ")).toBe("acme.test");
  });

  test("a secret is bound to its tenant and connection", () => {
    expect(contextOf("t1", "acme")).toBe("t1:acme");
  });

  test("claims keep the non-blank strings only", () => {
    expect(
      claimsOf({ email: "mail", name: "", picture: null, emailVerified: "v" }),
    ).toEqual({ email: "mail", emailVerified: "v" });
    expect(claimsOf(null)).toEqual({});
    expect(claimsOf(undefined)).toEqual({});
  });

  test("an empty patch keeps the current fields", () => {
    expect(nextOf(current, {})).toEqual({
      issuer: "https://idp.test",
      clientId: "client",
      clientAuthentication: "basic",
      idTokenSignedResponseAlg: null,
      scopes: null,
      emailTrust: "domain",
      claims: { email: "mail" },
      upstreamAcr: "mfa",
    });
  });

  test("a patch overrides, and null clears an optional field", () => {
    const next = nextOf(current, {
      issuer: "https://other.test",
      clientAuthentication: null,
      scopes: ["openid"],
      claims: { name: "n", email: "" },
      upstreamMfa: null,
    });
    expect(next).toMatchObject({
      issuer: "https://other.test",
      clientAuthentication: null,
      scopes: ["openid"],
      claims: { name: "n" },
      upstreamAcr: null,
    });
  });
});

describe("algorithmOf", () => {
  test("none pinned is null, a listed algorithm is kept", () => {
    expect(algorithmOf(undefined)).toBeNull();
    expect(algorithmOf("RS256")).toBe("RS256");
    expect(algorithmOf("EdDSA")).toBe("EdDSA");
  });

  test("an algorithm the SDL does not list is never stored", () => {
    expect(() => algorithmOf("HS256")).toThrow(
      'Unknown ID token algorithm "HS256"',
    );
  });
});
