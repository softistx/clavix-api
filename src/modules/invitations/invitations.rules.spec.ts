import { describe, expect, test } from "bun:test";
import {
  adminScope,
  adminTenantOf,
  inviteRefusal,
  isOperatorScope,
  operatorScope,
  retryAfterSeconds,
  userScope,
} from "./invitations.rules";
import type { StoredInvitation } from "./invitations.types";

const at = (day: number) => new Date(Date.UTC(2026, 0, day));
const pending = (email: string, updatedAt = at(1)): StoredInvitation => ({
  id: email,
  email,
  role: "member",
  createdAt: at(1),
  updatedAt,
  expiresAt: at(8),
  invitedBy: null,
});
const limits = (seconds: number, maxPending = 2) => ({
  now: at(1).getTime() + seconds * 1000,
  cooldownMs: 60_000,
  maxPending,
});

describe("scopes", () => {
  test("an admin scope names its tenant, any other scope names none", () => {
    expect(adminTenantOf(adminScope("t1"))).toBe("t1");
    expect(adminTenantOf(userScope())).toBeNull();
    expect(adminTenantOf(operatorScope())).toBeNull();
    expect(isOperatorScope(operatorScope())).toBe(true);
    expect(isOperatorScope(userScope())).toBe(false);
  });
});

describe("retryAfterSeconds", () => {
  test("rounds the wait up to whole seconds, 0 once it has passed", () => {
    expect(retryAfterSeconds(at(1), 60_000, at(1).getTime() + 30_500)).toBe(30);
    expect(retryAfterSeconds(at(1), 60_000, at(1).getTime() + 60_000)).toBe(0);
    expect(retryAfterSeconds(at(1), 60_000, at(1).getTime() + 90_000)).toBe(0);
  });
});

describe("inviteRefusal", () => {
  test("refuses a young pending invitation of the same address, case-blind", () => {
    const refusal = inviteRefusal(
      [pending("a@x.test")],
      " A@X.test ",
      limits(10),
    );
    expect(refusal?.code).toBe("INVITE_TOO_SOON");
    expect(refusal?.retryAfter).toBe(50);
  });
  test("lets an old one be replaced even at the cap", () => {
    const list = [pending("a@x.test"), pending("b@x.test")];
    expect(inviteRefusal(list, "a@x.test", limits(61))).toBeNull();
  });
  test("refuses a new address at the cap, accepts it under", () => {
    const list = [pending("a@x.test"), pending("b@x.test")];
    expect(inviteRefusal(list, "c@x.test", limits(61))?.code).toBe(
      "PENDING_INVITATIONS_LIMIT",
    );
    expect(inviteRefusal(list, "c@x.test", limits(61, 3))).toBeNull();
  });
});
