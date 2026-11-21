import { describe, expect, spyOn, test } from "bun:test";
import { rolesService } from "@/config/roles";
import { membersKey, PLATFORM_OWNERS_KEY } from "@/modules/admins";
import { adminInvitationHooks } from "@/modules/admins/admins.hooks";
import { adminScope } from "@/modules/invitations/invitations.rules";
import { userMutations } from "@/modules/users/users.console-mutations";
import { keepOwners } from "@/modules/users/users.owners";
import { withMembers } from "~/members";
import type { ConsoleContext } from "../context";
import { createExclusive } from "../exclusive";
import { userKey } from "./user-key";

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
    const ctx = withMembers({
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
    });
    await keepOwners(
      ctx,
      { slug: "clavix" },
      "u",
      async () => {},
      "delete",
      userKey(PLATFORM_ID, "u"),
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

  const consoleCtx = (exclusive: ConsoleContext["exclusive"]) =>
    withMembers({
      exclusive,
      canPlatform: async () => true,
      audit: async () => {},
      directory: {
        tenantsByIds: async () => [{ slug: "clavix", name: "Clavix" }],
        findUser: async (id: string) => ({ id, active: true }),
      },
      users: {
        setActive: async (_t: string, id: string, active: boolean) => ({
          id,
          active,
        }),
        delete: async () => {},
      },
      access: {
        memberships: async () => [{ tenantId: TENANT_A, role: "owner" }],
        platformRole: async () => null,
        owners: async () => ["u", "other"],
        platformOwners: async () => [],
        removeUser: async () => {},
      },
    });
  const call = (
    field: "disableUser" | "deleteUser",
    ctx: ConsoleContext,
  ): Promise<unknown> =>
    (
      userMutations[field] as unknown as (
        parent: unknown,
        args: unknown,
        ctx: ConsoleContext,
      ) => Promise<unknown>
    )(null, { tenantId: PLATFORM_ID, userId: "u" }, ctx);

  test("disableUser: members, then the user, innermost", async () => {
    const { exclusive, taken } = recording();
    await call("disableUser", consoleCtx(exclusive));
    expect(taken.map((t) => t.key)).toEqual([
      PLATFORM_OWNERS_KEY,
      membersKey(TENANT_A),
      userKey(PLATFORM_ID, "u"),
    ]);
    expectOrdered(taken);
  });

  test("deleteUser takes the same user key as the invitation hooks", async () => {
    const { exclusive, taken } = recording();
    const rm = spyOn(rolesService, "removeUser").mockResolvedValue(
      undefined as never,
    );
    try {
      await call("deleteUser", consoleCtx(exclusive));
    } finally {
      rm.mockRestore();
    }
    const hooksLocks = recording();
    const hooks = adminInvitationHooks({
      access: {
        holders: async () => [],
        grantTenant: async () => {},
        grantPlatform: async () => {},
        platformRole: async () => null,
      },
      exclusive: hooksLocks.exclusive,
      userLock: (id: string) => userKey(PLATFORM_ID, id),
      tenantActive: async () => true,
      findUser: async () => ({ active: true }),
    } as never);
    await hooks.onAccepted({
      invitation: { scope: adminScope(TENANT_A), role: "admin" },
      user: { id: "u" },
    } as never);
    const userKeys = (t: typeof taken) =>
      t.map((x) => x.key).filter((k) => k.startsWith("console:user:"));
    expect(userKeys(taken)).toEqual(userKeys(hooksLocks.taken));
    expect(userKeys(taken)).toEqual([userKey(PLATFORM_ID, "u")]);
  });
});
