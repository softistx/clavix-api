import { describe, expect, test } from "bun:test";
import { oauthPolicySchema } from "@/modules/oauth-policy";
import { signInPolicySchema } from "@/modules/sign-in-methods";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { withTenantState } from "./tenant-state";

describe("withTenantState", () => {
  const tenant = (status: ResolvedTenant["status"]): ResolvedTenant => ({
    tenantId: "t1",
    slug: "acme",
    name: "Acme",
    signUp: false,
    status,
    issuer: "https://acme.clavix.test",
    slugIssuer: "https://acme.clavix.test",
    relatedOrigins: [],
    plan: "free",
    partition: "t1",
    version: 1,
    signIn: signInPolicySchema.parse(undefined),
    oauth: oauthPolicySchema.parse(undefined),
  });
  const token = (sub: string) =>
    `h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`;

  function wrap(status: ResolvedTenant["status"]) {
    const seen: string[] = [];
    const active: string[] = [];
    const oauth = withTenantState(
      {
        handle: async (request: Request) => {
          seen.push(new URL(request.url).pathname);
          return Response.json({ access_token: token("user-1") });
        },
      },
      {
        resolver: { resolveRequest: async () => tenant(status) },
        onActive: (tenantId, userId) => {
          active.push(`${tenantId}/${userId}`);
        },
      },
    );
    const call = (path: string) =>
      oauth.handle(
        new Request(`https://acme.clavix.test${path}`, { method: "POST" }),
      );
    return { call, seen, active };
  }

  test("an active tenant passes through and its token counts the user", async () => {
    const { call, seen, active } = wrap("active");
    expect((await call("/token")).status).toBe(200);
    expect((await call("/authorize")).status).toBe(200);
    expect(seen).toEqual(["/token", "/authorize"]);
    expect(active).toEqual(["t1/user-1"]);
  });

  test.each(["suspended", "deleted"] as const)(
    "a %s tenant's /authorize, /par, /device_authorization and /token are 403 TENANT_SUSPENDED, the other endpoints answer",
    async (status) => {
      const { call, seen, active } = wrap(status);
      for (const path of [
        "/authorize",
        "/par",
        "/device_authorization",
        "/token",
      ]) {
        const response = await call(path);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          code: "TENANT_SUSPENDED",
        });
      }
      for (const path of [
        "/.well-known/openid-configuration",
        "/jwks.json",
        "/userinfo",
        "/introspect",
        "/revoke",
      ]) {
        expect((await call(path)).status).toBe(200);
      }
      expect(seen).not.toContain("/token");
      expect(active).toEqual([]);
    },
  );
});
