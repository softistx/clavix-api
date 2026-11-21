import { afterAll, describe, expect, test } from "bun:test";
import { scopeToTenant } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { rolesService } from "@/config/roles";
import { RolesError } from "./roles.errors";

// A tenant id of its own: the service reads and writes through the scope, so
// no tenant document is needed and no other spec's data is touched.
const tenant = new ObjectId();
const other = new ObjectId();

const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof RolesError ? error.code : String(error);
  }
  return undefined;
};

afterAll(async () => {
  for (const tenantId of [tenant, other]) {
    await mongo.db.roles.raw.deleteMany({ tenantId });
    await mongo.db.roleAssignments.raw.deleteMany({ tenantId });
    await mongo.db.resources.raw.deleteMany({ tenantId });
  }
});

describe("roles", () => {
  test("create trims, refuses a bad name and a repeat, and lists by name", async () => {
    const b = await rolesService.create(tenant, { name: " svc-b " });
    await rolesService.create(tenant, { name: "svc-a", description: "d" });
    expect(b.name).toBe("svc-b");
    expect(await code(() => rolesService.create(tenant, { name: "a b" }))).toBe(
      "BAD_USER_INPUT",
    );
    // The same role again is the stored one; another description is a conflict.
    expect((await rolesService.create(tenant, { name: "svc-b" }))._id).toEqual(
      b._id,
    );
    expect(
      await code(() =>
        rolesService.create(tenant, { name: "svc-b", description: "other" }),
      ),
    ).toBe("CONFLICT");
    expect((await rolesService.list(tenant)).map((r) => r.name)).toEqual([
      "svc-a",
      "svc-b",
    ]);
    expect(await rolesService.list(other)).toEqual([]);
  });

  test("a role scoped to an unknown resource is refused", async () => {
    expect(
      await code(() =>
        rolesService.create(tenant, {
          name: "svc-x",
          resourceId: new ObjectId().toHexString(),
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await code(() =>
        rolesService.create(tenant, { name: "svc-x", resourceId: "nope" }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("update changes name and description; a managed role is refused", async () => {
    const role = await rolesService.create(tenant, { name: "svc-u" });
    const id = role._id.toHexString();
    const updated = await rolesService.update(tenant, id, {
      description: "new",
    });
    expect(updated.description).toBe("new");
    expect(await code(() => rolesService.update(other, id, {}))).toBe(
      "NOT_FOUND",
    );
    const managed = await rolesService.create(tenant, {
      name: "svc-m",
      managed: true,
    });
    const managedId = managed._id.toHexString();
    expect(
      await code(() => rolesService.update(tenant, managedId, { name: "z" })),
    ).toBe("ROLE_MANAGED");
    expect(await code(() => rolesService.delete(tenant, managedId))).toBe(
      "ROLE_MANAGED",
    );
  });

  test("assign is idempotent, counts, pages and sweeps with the role", async () => {
    const role = await rolesService.create(tenant, { name: "svc-held" });
    const id = role._id.toHexString();
    await rolesService.assign(tenant, id, "user-1");
    await rolesService.assign(tenant, id, "user-1");
    await rolesService.assign(tenant, id, "user-2");
    expect(await rolesService.membersCount(tenant, id)).toBe(2);
    expect(await rolesService.memberCount(tenant, role)).toBe(2);
    expect((await rolesService.memberCounts(tenant, [role])).get(id)).toBe(2);
    const page = await rolesService.members(tenant, id, {
      after: null,
      limit: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect(
      (await rolesService.rolesOfUser(tenant, "user-1")).map((r) => r.name),
    ).toEqual(["svc-held"]);
    expect(await code(() => rolesService.assign(tenant, id, ""))).toBe(
      "BAD_USER_INPUT",
    );
    expect(
      await code(() =>
        rolesService.assign(tenant, new ObjectId().toHexString(), "u"),
      ),
    ).toBe("NOT_FOUND");
    expect(await rolesService.unassign(tenant, id, "user-2")).toBe(true);
    expect(await rolesService.unassign(tenant, id, "user-2")).toBe(false);
    expect(await rolesService.removeUser(tenant, "user-1")).toBe(1);
    await rolesService.assign(tenant, id, "user-3");
    expect(await rolesService.delete(tenant, id)).toBe(true);
    expect(await rolesService.delete(tenant, id)).toBe(false);
    expect(await rolesService.membersCount(tenant, id)).toBe(0);
  });

  test("the claim holds the tenant-wide roles and those of the audience's resource", async () => {
    const resource = await scopeToTenant(mongo.db.resources, tenant).create({
      uri: "https://api.svc.example/v1",
      name: "svc",
    });
    const wide = await rolesService.create(tenant, { name: "svc-wide" });
    const scoped = await rolesService.create(tenant, {
      name: "svc-scoped",
      resourceId: resource._id.toHexString(),
    });
    for (const role of [wide, scoped]) {
      await rolesService.assign(tenant, role._id.toHexString(), "claimant");
    }
    expect(await rolesService.claimRoles(tenant, "claimant", null)).toEqual([
      "svc-wide",
    ]);
    expect(
      await rolesService.claimRoles(
        tenant,
        "claimant",
        "https://api.svc.example/v1",
      ),
    ).toEqual(["svc-scoped", "svc-wide"]);
    expect(await rolesService.claimRoles(tenant, "nobody", null)).toEqual([]);
    // Deleting the resource's roles removes the scoped one and its assignment.
    const removed = await rolesService.deleteForResource(tenant, resource._id);
    expect(removed.map((r) => r.name)).toEqual(["svc-scoped"]);
    expect(
      await rolesService.claimRoles(
        tenant,
        "claimant",
        "https://api.svc.example/v1",
      ),
    ).toEqual(["svc-wide"]);
  });
});
