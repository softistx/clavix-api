import { describe, expect, test } from "bun:test";
import type { OAuthPrincipal } from "@softistx/janus-oauth";
import {
  oauthServerDouble,
  serverAuthenticating,
  serverRevoking,
} from "~/oauth-server-double";

const principal: OAuthPrincipal = {
  userId: "u1",
  clientId: "c1",
  grantId: "g1",
  scopes: ["read"],
  clientName: null,
  bound: null,
  jkt: null,
  authorizationDetails: [],
};
const request = new Request("https://api.acme.test/mcp");

describe("oauthServerDouble", () => {
  test("is a real server of its own each call", () => {
    const server = oauthServerDouble();
    expect(server.grants.revokeAll).toBeFunction();
    expect(server).not.toBe(oauthServerDouble());
  });

  test("replaces revokeAll only", () => {
    const revokeAll = async () => 3;
    const plain = oauthServerDouble();
    const server = serverRevoking(revokeAll);
    expect(server.grants.revokeAll).toBe(revokeAll);
    expect(server.grants.revoke).toBeFunction();
    expect(plain.grants.revokeAll).not.toBe(revokeAll);
  });

  test("answers the principal to every authentication", async () => {
    const server = serverAuthenticating(principal);
    expect(
      await server.authenticateRequest(request, { resource: "r" }),
    ).toEqual({
      ok: principal,
    });
  });

  test("keeps the real authentication without a principal", async () => {
    const server = oauthServerDouble();
    const answer = await server.authenticateRequest(request, {
      resource: "https://api.acme.test/mcp",
    });
    expect("ok" in answer).toBeFalse();
  });
});
