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
    () => async () => ({ roles: ["member"], permissions: null }),
    new Set<string>(),
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

describe("accessTokenClaims and RBAC", () => {
  const forged = async () => ({ permissions: ["x"], roles: ["root"] });
  const calls: string[] = [];
  const build = (enforcing: string[]) =>
    accessTokenClaims(
      tenant,
      () => async () => {
        calls.push("rolesFor");
        return ["from-roles"];
      },
      () => forged,
      () => async () => {
        calls.push("permissionsFor");
        return { roles: ["from-access"], permissions: ["read"] };
      },
      new Set(enforcing),
    );

  test("with the flag off an attribute named permissions or roles is dropped, and only rolesFor is asked", async () => {
    calls.length = 0;
    const result: Record<string, unknown> = await build([])(grant);
    expect(result).not.toHaveProperty("permissions");
    expect(result["roles"]).toEqual(["from-roles"]);
    expect(calls).toEqual(["rolesFor"]);
  });

  test("with the flag on the token has the computed permissions and roles, and only permissionsFor is asked", async () => {
    calls.length = 0;
    const result: Record<string, unknown> = await build([grant.audience])(
      grant,
    );
    expect(result["permissions"]).toEqual(["read"]);
    expect(result["roles"]).toEqual(["from-access"]);
    expect(calls).toEqual(["permissionsFor"]);
  });

  test("the userinfo audience and a client token never carry permissions", async () => {
    const enforcing = build([grant.audience, userinfoOf(tenant.issuer)]);
    calls.length = 0;
    expect(
      await enforcing({ ...grant, audience: userinfoOf(tenant.issuer) }),
    ).not.toHaveProperty("permissions");
    expect(
      await enforcing({ ...grant, subjectType: "client" }),
    ).not.toHaveProperty("permissions");
    expect(calls).toEqual(["rolesFor"]);
  });
});
