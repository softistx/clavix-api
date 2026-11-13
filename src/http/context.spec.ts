import { expect, test } from "bun:test";
import { signInPolicySchema } from "@/modules/sign-in-methods/sign-in.schema";
import type { TenantResolver } from "../tenancy/resolver";
import { createBase } from "./context";

const tenant = {
  tenantId: "t1",
  slug: "acme",
  name: "Acme",
  signUp: false,
  status: "active" as const,
  issuer: "https://acme.clavix.test",
  slugIssuer: "https://acme.clavix.test",
  partition: "t1",
  version: 1,
  signIn: signInPolicySchema.parse(undefined),
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
  const app = createBase(resolver).get("/who", async ({ reply, tenant }) => {
    const [a, b] = await Promise.all([tenant(), tenant()]);
    return reply(200, { slug: a?.slug, same: a === b });
  });
  const response = await app.request("http://acme.clavix.test/who");
  expect(await response.json()).toEqual({ slug: "acme", same: true });
  expect(seen).toEqual(["acme.clavix.test"]);
  await app.request("http://acme.clavix.test/who");
  expect(seen).toHaveLength(2);
});
