import { describe, expect, test } from "bun:test";
import type { Role } from "../../model";
import { type AdminsAccess, setRole } from "./service";

/**
 * Relations in memory. With `meet`, every revoke of `owner` waits until that
 * many are under way: the removals have then all passed their first check.
 */
function fakeAccess(owners: string[], meet = 0) {
  const held = new Map<Role, Set<string>>([
    ["owner", new Set(owners)],
    ["admin", new Set()],
    ["viewer", new Set()],
  ]);
  let waiting = 0;
  let release: () => void = () => {};
  const together = new Promise<void>((resolve) => {
    release = resolve;
  });
  const access: AdminsAccess = {
    holders: async (_tenant, role) => [...(held.get(role) ?? [])],
    grantTenant: async (_tenant, user, role) => {
      held.get(role)?.add(user);
    },
    revokeTenant: async (_tenant, user, role) => {
      if (role === "owner" && meet > 0) {
        waiting += 1;
        if (waiting >= meet) release();
        await together;
      }
      held.get(role)?.delete(user);
    },
  };
  return { access, held };
}

const codeOf = (result: PromiseSettledResult<void>) =>
  result.status === "rejected"
    ? (result.reason as { extensions?: { code?: string } }).extensions?.code
    : undefined;

describe("setRole, the last owner", () => {
  test("two owners removed at the same moment: the tenant keeps an owner", async () => {
    const { access, held } = fakeAccess(["a", "b"], 2);
    const results = await Promise.allSettled([
      setRole(access, "t", "a", null),
      setRole(access, "t", "b", null),
    ]);
    expect(held.get("owner")?.size).toBeGreaterThanOrEqual(1);
    expect(results.map(codeOf)).toContain("LAST_OWNER");
  });

  test("two owners demoted at the same moment: an owner stays, and a refused one keeps only owner", async () => {
    const { access, held } = fakeAccess(["a", "b"], 2);
    const results = await Promise.allSettled([
      setRole(access, "t", "a", "admin"),
      setRole(access, "t", "b", "viewer"),
    ]);
    const owners = held.get("owner") ?? new Set();
    expect(owners.size).toBeGreaterThanOrEqual(1);
    expect(results.map(codeOf)).toContain("LAST_OWNER");
    for (const owner of owners) {
      expect(held.get("admin")?.has(owner)).toBe(false);
      expect(held.get("viewer")?.has(owner)).toBe(false);
    }
  });

  test("one of two owners steps down", async () => {
    const { access, held } = fakeAccess(["a", "b"]);
    await setRole(access, "t", "a", "admin");
    expect([...(held.get("owner") ?? [])]).toEqual(["b"]);
    expect([...(held.get("admin") ?? [])]).toEqual(["a"]);
  });
});
