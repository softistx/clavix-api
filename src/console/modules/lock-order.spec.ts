import { describe, expect, test } from "bun:test";
import { adminScope } from "@/invitations/scope";
import type { ConsoleContext } from "../context";
import { createExclusive } from "../exclusive";
import { adminInvitationHooks } from "./admins/accept";
import { membersKey, PLATFORM_OWNERS_KEY } from "./admins/service";
import { userKey } from "./user-key";
import { keepOwners } from "./users/operators";

// The lock order every writer keeps, so two of them cannot deadlock:
// the platform owners, then the tenants' members (sorted), then the user.
const rank = (key: string) =>
  key === PLATFORM_OWNERS_KEY
    ? 0
    : key.startsWith("console:members:")
      ? 1
      : key.startsWith("console:user:")
        ? 2
        : Number.NaN;

/** An `Exclusive` that records each key taken, with the keys already held. */
function recording() {
  const inner = createExclusive();
  const held: string[] = [];
  const taken: { key: string; under: string[] }[] = [];
  const exclusive = <T>(key: string, work: () => Promise<T>) =>
    inner(key, () => {
      taken.push({ key, under: [...held] });
      held.push(key);
      return work().finally(() => {
        held.pop();
      });
    });
  return { exclusive, taken };
}

/** Every acquisition ranks above the ones it is nested in (members: ascending). */
function expectOrdered(taken: { key: string; under: string[] }[]) {
  for (const { key, under } of taken) {
    expect(Number.isNaN(rank(key))).toBe(false);
    for (const outer of under) {
      expect(rank(outer)).toBeLessThanOrEqual(rank(key));
      if (rank(outer) === 1 && rank(key) === 1) {
        expect(outer < key).toBe(true);
      }
    }
  }
}

const TENANT_A = "6553f1c2a1b2c3d4e5f60718";
const TENANT_B = "7653f1c2a1b2c3d4e5f60719";
const PLATFORM_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

describe("the lock order", () => {
  test("deleteUser: platform owners, then members by id, then the user", async () => {
    const { exclusive, taken } = recording();
    const ctx = {
      exclusive,
      canPlatform: async () => true,
      directory: { findUser: async (id: string) => ({ id, active: true }) },
      access: {
        memberships: async () => [
          { tenantId: TENANT_B, role: "admin" },
          { tenantId: TENANT_A, role: "owner" },
        ],
        platformRole: async () => "owner",
        owners: async () => ["u", "other"],
        platformOwners: async () => ["u", "other"],
      },
    } as unknown as ConsoleContext;
    await keepOwners(
      ctx,
      { slug: "clavix" },
      "u",
      () => exclusive(userKey(PLATFORM_ID, "u"), async () => {}),
      "delete",
    );
    expect(taken.map((t) => t.key)).toEqual([
      PLATFORM_OWNERS_KEY,
      membersKey(TENANT_A),
      membersKey(TENANT_B),
      userKey(PLATFORM_ID, "u"),
    ]);
    expectOrdered(taken);
  });

  test("accepting an invitation: members, then the user", async () => {
    const { exclusive, taken } = recording();
    const hooks = adminInvitationHooks({
      access: {
        holders: async () => [],
        grantTenant: async () => {},
        grantPlatform: async () => {},
        platformRole: async () => null,
      },
      exclusive,
      userLock: (id: string) => userKey(PLATFORM_ID, id),
      tenantActive: async () => true,
      findUser: async () => ({ active: true }),
    } as never);
    await hooks.onAccepted({
      invitation: { scope: adminScope(TENANT_A), role: "admin" },
      user: { id: "u" },
    } as never);
    expect(taken.map((t) => t.key)).toEqual([
      membersKey(TENANT_A),
      userKey(PLATFORM_ID, "u"),
    ]);
    expectOrdered(taken);
  });
});
