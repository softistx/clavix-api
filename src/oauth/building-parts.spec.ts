import { describe, expect, test } from "bun:test";
import { tenantStandIn } from "~/spec-context";
import { accessTokenClaims, userinfoOf } from "./building-parts";

const tenant = tenantStandIn();
const grant = {
  subject: "u1",
  audience: "https://api.test",
  scopes: ["read"],
};

describe("accessTokenClaims", () => {
  const calls: unknown[] = [];
  const claims = accessTokenClaims(
    tenant,
    () => async () => ["member"],
    () =>
      async (...args) => {
        calls.push(args);
        return { nick: "bob", sub: "evil", aud: "evil", scope: "all" };
      },
  );

  test("an attribute claim never takes the place of a claim the server owns", async () => {
    const result: Record<string, unknown> = await claims(grant);
    expect(result).toEqual({ nick: "bob", roles: ["member"] });
    expect(calls.at(-1)).toEqual(["u1", ["read"], "https://api.test"]);
  });

  test("the userinfo audience is no resource", async () => {
    await claims({ ...grant, audience: userinfoOf(tenant.issuer) });
    expect(calls.at(-1)).toEqual(["u1", ["read"], null]);
  });

  test("the grant's own claims are added when it records them", async () => {
    const result = await claims({
      ...grant,
      authTime: new Date(5000),
      acr: "2",
      amr: ["pwd"],
    });
    expect(result).toMatchObject({ auth_time: 5, acr: "2", amr: ["pwd"] });
  });

  test("a machine has neither roles nor attributes", async () => {
    const before = calls.length;
    const result: Record<string, unknown> = await claims({
      ...grant,
      subjectType: "client",
    });
    expect(result).toEqual({});
    expect(calls).toHaveLength(before);
  });
});
