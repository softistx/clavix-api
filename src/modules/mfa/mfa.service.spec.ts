import { describe, expect, test } from "bun:test";
import { GraphQLError } from "graphql";
import { tenantMail } from "@/config/mail";
import type { TenantJanus } from "@/modules/users";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { janusOver } from "~/janus-double";
import { instance } from "~/narrow";
import { contextOf, tenantStandIn } from "~/spec-context";
import { MfaService } from "./mfa.service";

// The service over stubbed ports: the refusals that come before janus is
// asked. The sign-ins and the step-ups end to end are the HTTP specs beside.
const serviceOver = (auth: TenantJanus | null) =>
  new MfaService({
    issuers: { forRequest: async () => auth },
    now: () => new Date(),
    mailOf: tenantMail,
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
    const service = serviceOver(janusOver());
    const { ctx, checks } = ctxOf(tenantStandIn({ status: "suspended" }));
    expect(await codeOf(() => service.passkeyOptions(ctx, "c"))).toBe(
      "TENANT_SUSPENDED",
    );
    expect(checks).toHaveLength(0);
  });

  test("a step-up confirmation needs a signed-in user", async () => {
    const service = serviceOver(janusOver({ authenticate: async () => null }));
    const { ctx } = ctxOf();
    expect(
      await codeOf(() => service.confirmPasskeyStepUp(ctx, "c", "{}")),
    ).toBe("UNAUTHENTICATED");
  });
});
