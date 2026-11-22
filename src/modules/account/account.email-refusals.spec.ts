import { describe, expect, test } from "bun:test";
import { JanusError } from "@softistx/janus";
import type { TenantJanus } from "@/modules/users";
import { janusOver, signedAs } from "~/janus-double";
import { contextOf, tenantStandIn } from "~/spec-context";
import { AccountService } from "./account.service";

const ctx = contextOf({ tenant: tenantStandIn({ tenantId: "a".repeat(24) }) });
const failure = (code: string) => Object.assign(new JanusError(code), { code });

const unused = async (): Promise<never> => {
  throw new Error("not reached");
};
const noMail = (): never => {
  throw new Error("no mail on a refusal");
};
const service = (auth: TenantJanus) =>
  new AccountService({
    issuers: { forRequest: async () => auth },
    mailOf: noMail,
    profilePolicies: { lockedFor: async () => [] },
    values: { checkEditable: unused, editableOf: unused, save: unused },
    exclusive: async (_key, run) => run(),
    now: () => new Date("2026-11-22T00:00:00Z"),
    log: () => {},
  });

/** A signed-in `u1` whose `changeEmail.confirm` and `update` fail with `code`. */
function failing(code: string): TenantJanus {
  const base = janusOver();
  const signed = signedAs("u1");
  return janusOver({
    authenticate: async () => signed,
    findUser: async () => signed.user,
    changeEmail: {
      ...base.changeEmail,
      confirm: async () => {
        throw failure(code);
      },
    },
    update: async () => {
      throw failure(code);
    },
  });
}

const codeOf = (run: () => Promise<unknown>) =>
  run().then(
    () => undefined,
    (error: unknown) =>
      Reflect.get(Reflect.get(error ?? {}, "extensions") ?? {}, "code"),
  );

describe("confirmEmailChange refusals", () => {
  for (const code of [
    "TOKEN_UNKNOWN",
    "TOKEN_SPENT",
    "TOKEN_EXPIRED",
    "TOKEN_STALE",
    "USER_INACTIVE",
  ]) {
    test(`${code} is one EMAIL_CHANGE_INVALID`, async () => {
      expect(
        await codeOf(() => service(failing(code)).confirmEmailChange(ctx, "t")),
      ).toBe("EMAIL_CHANGE_INVALID");
    });
  }

  test("VERSION_CONFLICT is CONFLICT, so the page retries the link", async () => {
    expect(
      await codeOf(() =>
        service(failing("VERSION_CONFLICT")).confirmEmailChange(ctx, "t"),
      ),
    ).toBe("CONFLICT");
  });

  test("LOGIN_TAKEN is not reworded: janus's own error reaches the API's error mapping", async () => {
    await expect(
      service(failing("LOGIN_TAKEN")).confirmEmailChange(ctx, "t"),
    ).rejects.toBeInstanceOf(JanusError);
  });
});

describe("updateMyProfile on a moved version", () => {
  test("VERSION_CONFLICT is CONFLICT", async () => {
    expect(
      await codeOf(() =>
        service(failing("VERSION_CONFLICT")).updateMyProfile(ctx, {
          givenName: "Ada",
        }),
      ),
    ).toBe("CONFLICT");
  });
});

describe("requestEmailChange throttle", () => {
  test("is counted against the client address and the tenant, before any mail", async () => {
    const seen: unknown[] = [];
    const signed = signedAs("u1");
    const throttled = contextOf({
      tenant: tenantStandIn({ tenantId: "a".repeat(24) }),
      ip: "203.0.113.7",
      janus: {
        session: async () => ({
          ...signed.session,
          authenticatedAt: new Date(),
        }),
      },
      throttles: {
        verifyThrottle: {
          check: async (key) => {
            seen.push(key);
            throw new Error("throttled");
          },
        },
      },
    });
    await expect(
      service(failing("TOKEN_UNKNOWN")).requestEmailChange(
        throttled,
        "a@b.test",
      ),
    ).rejects.toThrow("throttled");
    expect(seen).toEqual([
      { tenantId: "a".repeat(24), userId: "u1", ip: "203.0.113.7" },
    ]);
  });
});
