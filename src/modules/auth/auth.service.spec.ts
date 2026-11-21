import { describe, expect, test } from "bun:test";
import { GraphQLError } from "graphql";
import { tenantMail } from "@/config/mail";
import type { TenantJanus } from "@/modules/users";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { janusOver, signedAs } from "~/janus-double";
import { instance } from "~/narrow";
import { type ContextParts, contextOf, tenantStandIn } from "~/spec-context";
import { AuthService } from "./auth.service";

// The service over stubbed ports: the refusals that come before any store,
// throttle or mail is touched. The flows end to end are the HTTP specs beside.
const stubbed = (auth: TenantJanus | null) => {
  const recorded: string[] = [];
  const service = new AuthService({
    log: () => {},
    issuers: { forRequest: async () => auth },
    now: () => new Date(),
    mailOf: tenantMail,
    usage: { recordActive: async (_, userId) => void recorded.push(userId) },
  });
  return { service, recorded };
};

const ctxOf = (
  tenant: ResolvedTenant | null = tenantStandIn(),
  parts: ContextParts = {},
) => {
  const headers = new Headers();
  const checks: unknown[] = [];
  const ctx = contextOf({
    tenant,
    headers,
    throttles: {
      signInThrottle: { check: async (key) => void checks.push(key) },
    },
    ...parts,
  });
  return { ctx, headers, checks };
};

const codeOf = async (run: () => Promise<unknown>) =>
  instance(await run().catch((error: unknown) => error), GraphQLError)
    .extensions["code"];

describe("AuthService", () => {
  test("a host that names no tenant is NOT_FOUND on every operation", async () => {
    const { service } = stubbed(null);
    const { ctx } = ctxOf();
    expect(await codeOf(() => service.requestSignInCode(ctx, "a@x.test"))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(() => service.signOut(ctx))).toBe("NOT_FOUND");
    const none = ctxOf(null).ctx;
    expect(
      await codeOf(() =>
        stubbed(janusOver()).service.confirmMagicLink(none, "t"),
      ),
    ).toBe("NOT_FOUND");
  });

  test("a suspended tenant refuses a sign-in before anything is counted", async () => {
    const { service } = stubbed(janusOver());
    const { ctx, checks } = ctxOf(tenantStandIn({ status: "suspended" }));
    expect(await codeOf(() => service.requestSignInCode(ctx, "a@x.test"))).toBe(
      "TENANT_SUSPENDED",
    );
    expect(checks).toHaveLength(0);
  });

  test("the magic link is off: 404 before the throttle, the store or the mail", async () => {
    const { service } = stubbed(janusOver());
    const { ctx, checks } = ctxOf();
    expect(await codeOf(() => service.requestMagicLink(ctx, "a@x.test"))).toBe(
      "MAGIC_LINK_DISABLED",
    );
    expect(await codeOf(() => service.confirmMagicLink(ctx, "t"))).toBe(
      "MAGIC_LINK_DISABLED",
    );
    expect(checks).toHaveLength(0);
  });

  test("the e-mail verification needs a session", async () => {
    const { service } = stubbed(janusOver({ authenticate: async () => null }));
    const { ctx } = ctxOf();
    expect(await codeOf(() => service.requestEmailVerification(ctx))).toBe(
      "UNAUTHENTICATED",
    );
    expect(await codeOf(() => service.confirmEmailVerification(ctx, "t"))).toBe(
      "UNAUTHENTICATED",
    );
  });

  test("the current user is null when anonymous, the public fields when signed in", async () => {
    const { service } = stubbed(janusOver());
    expect(await service.currentUser(ctxOf().ctx)).toBeNull();
    const signedIn = ctxOf(tenantStandIn(), {
      janus: {
        user: async () =>
          Object.assign(signedAs("u1", "a@x.test").user, { hash: "secret" }),
      },
    }).ctx;
    expect(await service.currentUser(signedIn)).toEqual({
      id: "u1",
      email: "a@x.test",
      name: null,
      emailVerified: true,
    });
  });

  test("signing out ends the session and clears the cookie, signed in or not", async () => {
    const ended: unknown[] = [];
    const base = janusOver();
    const { service } = stubbed(
      janusOver({
        authenticate: async () => null,
        signOut: async (request) => ended.push(request) > 0,
        cookie: { ...base.cookie, clear: () => "session=; Max-Age=0" },
      }),
    );
    const { ctx, headers } = ctxOf();
    expect(await service.signOut(ctx)).toBe(true);
    expect(ended).toHaveLength(1);
    expect(headers.get("set-cookie")).toBe("session=; Max-Age=0");
  });
});
