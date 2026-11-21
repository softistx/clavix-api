import { describe, expect, test } from "bun:test";
import type { GraphQLError } from "graphql";
import { MfaService } from "./mfa.service";

// The service over stubbed ports: the refusals that come before janus is
// asked. The sign-ins and the step-ups end to end are the HTTP specs beside.
const serviceOver = (auth: object | null) =>
  new MfaService({
    issuers: { forRequest: async () => auth as never },
    now: () => new Date(),
    mailOf: () => ({}) as never,
    usage: { recordActive: async () => {} },
  });

const ctxOf = (
  tenant: object | null = { tenantId: "t1", status: "active" },
  user: object | null = null,
) => {
  const checks: unknown[] = [];
  const ctx = {
    request: new Request("https://acme.example/graphql"),
    ip: "198.51.100.9",
    tenant: async () => tenant,
    set: { headers: new Headers() },
    passkeyThrottle: { check: async (key: unknown) => void checks.push(key) },
    janus: { user: async () => user },
  };
  return { ctx: ctx as never, checks };
};

const codeOf = async (run: () => Promise<unknown>) =>
  ((await run().catch((error: GraphQLError) => error)) as GraphQLError)
    .extensions["code"];

describe("MfaService", () => {
  test("a host that names no tenant is NOT_FOUND", async () => {
    const service = serviceOver(null);
    const { ctx } = ctxOf(null);
    expect(
      await codeOf(() => service.confirmSecondFactorWithPasskey(ctx, "c", "a")),
    ).toBe("NOT_FOUND");
    expect(await codeOf(() => service.passkeyOptions(ctx, "c"))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(() => service.requestPasskeyStepUp(ctx))).toBe(
      "NOT_FOUND",
    );
  });

  test("a suspended tenant refuses the passkey options before any budget is spent", async () => {
    const service = serviceOver({});
    const { ctx, checks } = ctxOf({ tenantId: "t1", status: "suspended" });
    expect(await codeOf(() => service.passkeyOptions(ctx, "c"))).toBe(
      "TENANT_SUSPENDED",
    );
    expect(checks).toHaveLength(0);
  });

  test("a step-up confirmation needs a signed-in user", async () => {
    const service = serviceOver({ authenticate: async () => null });
    const { ctx } = ctxOf();
    expect(
      await codeOf(() => service.confirmPasskeyStepUp(ctx, "c", "{}")),
    ).toBe("UNAUTHENTICATED");
  });
});
