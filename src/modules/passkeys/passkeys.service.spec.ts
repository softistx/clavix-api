import { describe, expect, test } from "bun:test";
import { GraphQLError } from "graphql";
import type { TenantJanus } from "@/modules/users";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { janusOver, signedAs } from "~/janus-double";
import { instance } from "~/narrow";
import { contextOf, tenantStandIn } from "~/spec-context";
import { PasskeysService } from "./passkeys.service";

// The service over stubbed ports: the refusals that come before janus is
// asked. The sign-in and the management end to end are the HTTP specs beside.
const serviceOver = (auth: TenantJanus | null) =>
  new PasskeysService({
    issuers: { forRequest: async () => auth },
    usage: { recordActive: async () => {} },
  });

const ctxOf = (tenant: ResolvedTenant | null = tenantStandIn()) => {
  const checks: unknown[] = [];
  const ctx = contextOf({
    tenant,
    throttles: {
      passkeyThrottle: { check: async (key) => void checks.push(key) },
    },
  });
  return { ctx, checks };
};

const codeOf = async (run: () => Promise<unknown>) =>
  instance(await run().catch((error: unknown) => error), GraphQLError)
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
    const { ctx, checks } = ctxOf(tenantStandIn({ status: "suspended" }));
    expect(
      await codeOf(() => serviceOver(janusOver()).signInOptions(ctx)),
    ).toBe("TENANT_SUSPENDED");
    expect(checks).toHaveLength(0);
  });

  test("the management needs a session", async () => {
    const service = serviceOver(janusOver({ authenticate: async () => null }));
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
    const service = serviceOver(
      janusOver({ authenticate: async () => signedAs("u1") }),
    );
    expect(
      await codeOf(() => service.register(ctxOf().ctx, "c", "{nope", "Key")),
    ).toBe("BAD_USER_INPUT");
  });
});
