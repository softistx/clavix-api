import { describe, expect, test } from "bun:test";
import { createExclusive } from "../../exclusive";
import type { Role } from "../../model";
import { type AdminsAccess, changeRole, removeMember } from "./service";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

/** Relations in memory; every call yields, so unserialised calls would interleave. */
function fake(start: Partial<Record<Role, string[]>>) {
  const held = new Map<Role, Set<string>>([
    ["owner", new Set(start.owner)],
    ["admin", new Set(start.admin)],
    ["viewer", new Set(start.viewer)],
  ]);
  const access: AdminsAccess = {
    holders: async (_tenant, role) => {
      await tick();
      return [...(held.get(role) ?? [])];
    },
    grantTenant: async (_tenant, user, role) => {
      await tick();
      held.get(role)?.add(user);
    },
    revokeTenant: async (_tenant, user, role) => {
      await tick();
      held.get(role)?.delete(user);
    },
  };
  const of = (role: Role) => [...(held.get(role) ?? [])].sort();
  return { deps: { access, exclusive: createExclusive() }, of };
}

const codeOf = (result: PromiseSettledResult<unknown>) =>
  result.status === "rejected"
    ? (result.reason as { extensions?: { code?: string } }).extensions?.code
    : "ok";

describe("the last owner, under concurrent changes", () => {
  test("two owners removed at the same moment: one goes, the other is refused", async () => {
    const { deps, of } = fake({ owner: ["a", "b"] });
    const results = await Promise.allSettled([
      removeMember(deps, "t", "a"),
      removeMember(deps, "t", "b"),
    ]);
    expect(results.map(codeOf)).toEqual(["ok", "LAST_OWNER"]);
    expect(of("owner")).toEqual(["b"]);
  });

  test("two owners demoted at the same moment: an owner stays", async () => {
    const { deps, of } = fake({ owner: ["a", "b"] });
    const results = await Promise.allSettled([
      changeRole(deps, "t", "a", "admin"),
      changeRole(deps, "t", "b", "viewer"),
    ]);
    expect(results.map(codeOf)).toEqual(["ok", "LAST_OWNER"]);
    expect(of("owner")).toEqual(["b"]);
    expect(of("admin")).toEqual(["a"]);
    expect(of("viewer")).toEqual([]);
  });

  test("a no-op on b beside b's promotion and a's demotion never leaves no owner", async () => {
    // Unserialised, the first call read `b` as an admin, then revoked the
    // owner role `b` got meanwhile, after `a` had stepped down.
    const { deps, of } = fake({ owner: ["a"], admin: ["b"] });
    await Promise.allSettled([
      changeRole(deps, "t", "b", "admin"),
      changeRole(deps, "t", "b", "owner"),
      changeRole(deps, "t", "a", "admin"),
    ]);
    expect(of("owner")).toEqual(["b"]);
    expect(of("admin")).toEqual(["a"]);
  });

  test("two changes of one member: the member keeps exactly one role", async () => {
    const { deps, of } = fake({ owner: ["o"], viewer: ["a"] });
    const results = await Promise.all([
      changeRole(deps, "t", "a", "admin"),
      changeRole(deps, "t", "a", "viewer"),
    ]);
    expect(results).toEqual(["admin", "viewer"]);
    expect(of("admin")).toEqual([]);
    expect(of("viewer")).toEqual(["a"]);
  });

  test("a change answers NOT_FOUND for a non-member; removing one is a no-op", async () => {
    const { deps, of } = fake({ owner: ["o"] });
    const [change] = await Promise.allSettled([
      changeRole(deps, "t", "x", "admin"),
    ]);
    expect(codeOf(change as PromiseSettledResult<unknown>)).toBe("NOT_FOUND");
    await removeMember(deps, "t", "x");
    expect(of("admin")).toEqual([]);
    expect(of("owner")).toEqual(["o"]);
  });
});
