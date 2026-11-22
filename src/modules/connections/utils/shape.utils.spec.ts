import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { sealedUnder } from "~/webhook-docs";
import { connections } from "../connections.model";
import { AUTH, AUTH_IN, TRUST, TRUST_IN } from "./enums.utils";
import { connectionShape } from "./shape.utils";

const stamp = new Date("2026-01-01T00:00:00Z");
const _id = new ObjectId();
const doc = {
  ...connections.schema.parse({
    _id,
    tenantId: new ObjectId(),
    connectionId: "acme",
    name: "Acme",
    issuer: "https://idp.test",
    clientId: "client",
    secret: sealedUnder("k"),
    clientAuthentication: "basic",
    idTokenSignedResponseAlg: "RS256",
    scopes: null,
    emailTrust: "domain",
    claims: { email: "mail" },
    domains: [
      {
        domain: "acme.test",
        txtToken: "tok",
        verifiedAt: stamp,
        checkedAt: stamp,
      },
    ],
    createdAt: stamp,
    updatedAt: stamp,
  }),
  id: _id.toHexString(),
};

describe("the enum maps", () => {
  test("go both ways", () => {
    expect(TRUST_IN[TRUST.domain]).toBe("domain");
    expect(TRUST_IN[TRUST.claimAndDomain]).toBe("claimAndDomain");
    expect(AUTH_IN[AUTH.basic]).toBe("basic");
    expect(AUTH_IN[AUTH.post]).toBe("post");
  });
});

describe("connectionShape", () => {
  test("shows the connection with its redirect URI, enums and domains", () => {
    const shown = connectionShape(doc, "https://tenant.test");
    expect(shown).toMatchObject({
      id: "acme",
      clientAuthentication: "BASIC",
      emailTrust: "DOMAIN",
      idTokenSignedResponseAlg: "RS256",
      claims: { email: "mail", emailVerified: null, name: null, picture: null },
    });
    expect(shown.redirectUri).toContain("acme");
    expect(shown.domains).toEqual([
      {
        domain: "acme.test",
        txtName: "_clavix-sso.acme.test",
        txtToken: "tok",
        verified: true,
        verifiedAt: stamp,
        checkedAt: stamp,
      },
    ]);
  });

  test("an unpinned authentication stays null and an unverified domain says so", () => {
    const shown = connectionShape(
      {
        ...doc,
        clientAuthentication: null,
        domains: [
          {
            domain: "x.test",
            txtToken: "t",
            verifiedAt: null,
            checkedAt: null,
          },
        ],
      },
      "https://tenant.test",
    );
    expect(shown.clientAuthentication).toBeNull();
    expect(shown.domains[0]?.verified).toBe(false);
  });
});
