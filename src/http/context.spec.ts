import { expect, test } from "bun:test";
import { telemetry as appTelemetry } from "@/config/telemetry";
import { oauthPolicySchema } from "@/modules/oauth-policy";
import { signInPolicySchema } from "@/modules/sign-in-methods";
import { quietThrottles } from "~/ports";
import type { TenantResolver } from "../tenancy/resolver";
import { contextOf, createBase, isContext } from "./context";

const tenant = {
  tenantId: "t1",
  slug: "acme",
  name: "Acme",
  signUp: false,
  status: "active" as const,
  issuer: "https://acme.clavix.test",
  slugIssuer: "https://acme.clavix.test",
  relatedOrigins: [],
  plan: "free" as const,
  partition: "t1",
  version: 1,
  signIn: signInPolicySchema.parse(undefined),
  oauth: oauthPolicySchema.parse(undefined),
};

test("tenant() resolves the request's host once, on first use", async () => {
  const seen: string[] = [];
  const resolver: TenantResolver = {
    resolveHost: async () => null,
    resolveRequest: async (request) => {
      seen.push(new URL(request.url).host);
      return tenant;
    },
    invalidate: async () => {},
  };
  const app = createBase(resolver, quietThrottles, appTelemetry, 0).get(
    "/who",
    async ({ reply, tenant }) => {
      const [a, b] = await Promise.all([tenant(), tenant()]);
      return reply(200, { slug: a?.slug, same: a === b });
    },
  );
  const response = await app.request("http://acme.clavix.test/who");
  expect(await response.json()).toEqual({ slug: "acme", same: true });
  expect(seen).toEqual(["acme.clavix.test"]);
  await app.request("http://acme.clavix.test/who");
  expect(seen).toHaveLength(2);
});

test("contextOf returns the app's context and throws a plain Error for another", () => {
  const base = {
    tenant: async () => null,
    janus: { user: async () => null },
    deviceThrottle: { check: async () => {} },
  };
  expect(isContext(base)).toBe(true);
  expect(Object.is(contextOf(base), base)).toBe(true);
  expect(isContext({ ...base, janus: undefined })).toBe(false);
  expect(isContext({ ...base, deviceThrottle: null })).toBe(false);
  expect(isContext({ ...base, tenant: "t" })).toBe(false);
  expect(isContext(null)).toBe(false);
  const refusal = (() => {
    try {
      contextOf({ tenant: base.tenant });
    } catch (error) {
      return error;
    }
    return null;
  })();
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal).not.toHaveProperty("extensions");
});
