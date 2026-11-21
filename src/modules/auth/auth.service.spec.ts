import { describe, expect, test } from "bun:test";
import type { GraphQLError } from "graphql";
import { AuthService } from "./auth.service";

// The service over stubbed ports: the refusals that come before any store,
// throttle or mail is touched. The flows end to end are the HTTP specs beside.
const stubbed = (auth: object | null) => {
  const recorded: string[] = [];
  const service = new AuthService({
    issuers: { forRequest: async () => auth as never },
    mailOf: () => ({}) as never,
    usage: { recordActive: async (_, userId) => void recorded.push(userId) },
  });
  return { service, recorded };
};

const ctxOf = (
  tenant: object | null = { tenantId: "t1", status: "active" },
) => {
  const headers = new Headers();
  const checks: unknown[] = [];
  const ctx = {
    request: new Request("https://acme.example/graphql"),
    ip: "198.51.100.9",
    tenant: async () => tenant,
    set: { headers },
    signInThrottle: { check: async (key: unknown) => void checks.push(key) },
    janus: { user: async () => null },
  };
  return { ctx: ctx as never, headers, checks };
};

const codeOf = async (run: () => Promise<unknown>) =>
  ((await run().catch((error: GraphQLError) => error)) as GraphQLError)
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
      await codeOf(() => stubbed({}).service.confirmMagicLink(none, "t")),
    ).toBe("NOT_FOUND");
  });

  test("a suspended tenant refuses a sign-in before anything is counted", async () => {
    const { service } = stubbed({});
    const { ctx, checks } = ctxOf({ tenantId: "t1", status: "suspended" });
    expect(await codeOf(() => service.requestSignInCode(ctx, "a@x.test"))).toBe(
      "TENANT_SUSPENDED",
    );
    expect(checks).toHaveLength(0);
  });

  test("the magic link is off: 404 before the throttle, the store or the mail", async () => {
    const { service } = stubbed({ magicLink: { enabled: false } });
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
    const { service } = stubbed({ authenticate: async () => null });
    const { ctx } = ctxOf();
    expect(await codeOf(() => service.requestEmailVerification(ctx))).toBe(
      "UNAUTHENTICATED",
    );
    expect(await codeOf(() => service.confirmEmailVerification(ctx, "t"))).toBe(
      "UNAUTHENTICATED",
    );
  });

  test("the current user is null when anonymous, the public fields when signed in", async () => {
    const { service } = stubbed({});
    expect(await service.currentUser(ctxOf().ctx)).toBeNull();
    const signedIn = {
      ...(ctxOf().ctx as object),
      janus: {
        user: async () => ({
          id: "u1",
          email: "a@x.test",
          emailVerified: true,
          hash: "secret",
        }),
      },
    } as never;
    expect(await service.currentUser(signedIn)).toEqual({
      id: "u1",
      email: "a@x.test",
      name: null,
      emailVerified: true,
    });
  });

  test("signing out ends the session and clears the cookie, signed in or not", async () => {
    const ended: Request[] = [];
    const { service } = stubbed({
      authenticate: async () => null,
      signOut: async (request: Request) => void ended.push(request),
      cookie: { clear: () => "session=; Max-Age=0" },
    });
    const { ctx, headers } = ctxOf();
    expect(await service.signOut(ctx)).toBe(true);
    expect(ended).toHaveLength(1);
    expect(headers.get("set-cookie")).toBe("session=; Max-Age=0");
  });
});
