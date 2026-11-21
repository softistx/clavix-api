import { describe, expect, test } from "bun:test";
import type { GraphQLError } from "graphql";
import { PasskeysService } from "./passkeys.service";

// The service over stubbed ports: the refusals that come before janus is
// asked. The sign-in and the management end to end are the HTTP specs beside.
const serviceOver = (auth: object | null) =>
  new PasskeysService({
    issuers: { forRequest: async () => auth as never },
    usage: { recordActive: async () => {} },
  });

const ctxOf = (
  tenant: object | null = { tenantId: "t1", status: "active" },
) => {
  const checks: unknown[] = [];
  const ctx = {
    request: new Request("https://acme.example/graphql"),
    ip: "198.51.100.9",
    tenant: async () => tenant,
    set: { headers: new Headers() },
    passkeyThrottle: { check: async (key: unknown) => void checks.push(key) },
  };
  return { ctx: ctx as never, checks };
};

const codeOf = async (run: () => Promise<unknown>) =>
  ((await run().catch((error: GraphQLError) => error)) as GraphQLError)
    .extensions["code"];

describe("PasskeysService", () => {
  test("a host that names no tenant is NOT_FOUND before any budget is spent", async () => {
    const service = serviceOver(null);
    const { ctx, checks } = ctxOf(null);
    expect(await codeOf(() => service.signInOptions(ctx))).toBe("NOT_FOUND");
    expect(await codeOf(() => service.signIn(ctx, "c", "{}"))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(() => service.list(ctx))).toBe("NOT_FOUND");
    expect(checks).toHaveLength(0);
  });

  test("a suspended tenant refuses the sign-in options before any budget is spent", async () => {
    const { ctx, checks } = ctxOf({ tenantId: "t1", status: "suspended" });
    expect(await codeOf(() => serviceOver({}).signInOptions(ctx))).toBe(
      "TENANT_SUSPENDED",
    );
    expect(checks).toHaveLength(0);
  });

  test("the management needs a session", async () => {
    const service = serviceOver({
      authenticate: async () => null,
      passkeys: {},
    });
    const { ctx } = ctxOf();
    expect(await codeOf(() => service.list(ctx))).toBe("UNAUTHENTICATED");
    expect(await codeOf(() => service.registrationOptions(ctx))).toBe(
      "UNAUTHENTICATED",
    );
    expect(await codeOf(() => service.remove(ctx, "cred"))).toBe(
      "UNAUTHENTICATED",
    );
  });

  test("a registration answer that is not JSON is BAD_USER_INPUT", async () => {
    const service = serviceOver({
      authenticate: async () => ({ user: { id: "u1" } }),
      passkeys: {},
    });
    expect(
      await codeOf(() => service.register(ctxOf().ctx, "c", "{nope", "Key")),
    ).toBe("BAD_USER_INPUT");
  });
});
