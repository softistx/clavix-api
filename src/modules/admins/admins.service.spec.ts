import { describe, expect, test } from "bun:test";
import { GraphQLError } from "graphql";
import { createExclusive } from "@/console/exclusive";
import type { Role } from "@/console/model";
import { defined, instance } from "~/narrow";
import { AdminsService } from "./admins.service";
import type { AdminsAccess } from "./admins.types";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

/** Relations in memory; every call yields, so unserialised calls would interleave. */
function fake(
  start: Partial<Record<Role, string[]>>,
  { disabled = [], gone = [] }: { disabled?: string[]; gone?: string[] } = {},
) {
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
    platformHolders: async () => [],
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
  const directory = {
    findUser: async (id: string) =>
      gone.includes(id)
        ? null
        : { id, email: `${id}@t.test`, active: !disabled.includes(id) },
  };
  const service = new AdminsService({
    access,
    exclusive: createExclusive(null),
    directory,
  });
  return { service, of };
}

const codeOf = (result: PromiseSettledResult<unknown>) =>
  result.status === "rejected"
    ? instance(result.reason, GraphQLError).extensions["code"]
    : "ok";

describe("the last owner, under concurrent changes", () => {
  test("two owners removed at the same moment: one goes, the other is refused", async () => {
    const { service, of } = fake({ owner: ["a", "b"] });
    const results = await Promise.allSettled([
      service.removeMember("t", "a"),
      service.removeMember("t", "b"),
    ]);
    expect(results.map(codeOf)).toEqual(["ok", "LAST_OWNER"]);
    expect(of("owner")).toEqual(["b"]);
  });

  test("two owners demoted at the same moment: an owner stays", async () => {
    const { service, of } = fake({ owner: ["a", "b"] });
    const results = await Promise.allSettled([
      service.changeRole("t", "a", "admin"),
      service.changeRole("t", "b", "viewer"),
    ]);
    expect(results.map(codeOf)).toEqual(["ok", "LAST_OWNER"]);
    expect(of("owner")).toEqual(["b"]);
    expect(of("admin")).toEqual(["a"]);
    expect(of("viewer")).toEqual([]);
  });

  test("a no-op on b beside b's promotion and a's demotion never leaves no owner", async () => {
    // Unserialised, the first call read `b` as an admin, then revoked the
    // owner role `b` got meanwhile, after `a` had stepped down.
    const { service, of } = fake({ owner: ["a"], admin: ["b"] });
    await Promise.allSettled([
      service.changeRole("t", "b", "admin"),
      service.changeRole("t", "b", "owner"),
      service.changeRole("t", "a", "admin"),
    ]);
    expect(of("owner")).toEqual(["b"]);
    expect(of("admin")).toEqual(["a"]);
  });

  test("two changes of one member: the member keeps exactly one role", async () => {
    const { service, of } = fake({ owner: ["o"], viewer: ["a"] });
    const results = await Promise.all([
      service.changeRole("t", "a", "admin"),
      service.changeRole("t", "a", "viewer"),
    ]);
    expect(results).toEqual(["admin", "viewer"]);
    expect(of("admin")).toEqual([]);
    expect(of("viewer")).toEqual(["a"]);
  });

  test("a change answers NOT_FOUND for a non-member; removing one is a no-op", async () => {
    const { service, of } = fake({ owner: ["o"] });
    const [change] = await Promise.allSettled([
      service.changeRole("t", "x", "admin"),
    ]);
    expect(codeOf(defined(change, "the settled change"))).toBe("NOT_FOUND");
    await service.removeMember("t", "x");
    expect(of("admin")).toEqual([]);
    expect(of("owner")).toEqual(["o"]);
  });
});

describe("one owner rule: an owner who cannot sign in does not count", () => {
  test("disable X, then Y steps down or is removed: LAST_OWNER, nothing changed", async () => {
    const { service, of } = fake({ owner: ["x", "y"] }, { disabled: ["x"] });
    const results = await Promise.allSettled([
      service.changeRole("t", "y", "admin"),
      service.removeMember("t", "y"),
    ]);
    expect(results.map(codeOf)).toEqual(["LAST_OWNER", "LAST_OWNER"]);
    expect(of("owner")).toEqual(["x", "y"]);
  });

  test("an owner whose account is gone does not count either", async () => {
    const { service, of } = fake(
      { owner: ["ghost", "y"] },
      { gone: ["ghost"] },
    );
    const [removal] = await Promise.allSettled([
      service.removeMember("t", "y"),
    ]);
    expect(codeOf(defined(removal, "the settled removal"))).toBe("LAST_OWNER");
    expect(of("owner")).toEqual(["ghost", "y"]);
  });

  test("a live owner beside the one stepping down is enough", async () => {
    const { service, of } = fake(
      { owner: ["x", "y", "z"] },
      { disabled: ["x"] },
    );
    await service.removeMember("t", "y");
    expect(of("owner")).toEqual(["x", "z"]);
  });
});
