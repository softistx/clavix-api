import { afterAll, describe, expect, test } from "bun:test";
import { scopeToTenant } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { resourcesService } from "@/config/resources";
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
    await mongo.db.scopes.raw.deleteMany({ tenantId });
    await mongo.db.roleAttributes.raw.deleteMany({ tenantId });
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
    const link = await scopeToTenant(mongo.db.roleAttributes, tenant).create({
      roleId: scoped._id,
      attributeId: new ObjectId(),
      required: false,
    });
    const removed = await rolesService.deleteForResource(tenant, resource._id);
    // The role's attribute links go with it.
    expect(
      await mongo.db.roleAttributes.raw.countDocuments({
        _id: link._id,
      }),
    ).toBe(0);
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

describe("personalDataOf", () => {
  test("lists the roles a user holds by name with the assignment date, only theirs, for a tenant", async () => {
    const zeta = await rolesService.create(tenant, { name: "pd-zeta" });
    const alpha = await rolesService.create(tenant, { name: "pd-alpha" });
    await rolesService.assign(tenant, zeta._id.toHexString(), "pd-user");
    await rolesService.assign(tenant, alpha._id.toHexString(), "pd-user");
    await rolesService.assign(tenant, alpha._id.toHexString(), "pd-other");
    const held = await rolesService.personalDataOf(tenant, "pd-user");
    expect(held.map((r) => r.role)).toEqual(["pd-alpha", "pd-zeta"]);
    expect(held[0]?.assignedAt).toBeInstanceOf(Date);
    expect(await rolesService.personalDataOf(other, "pd-user")).toEqual([]);
    expect(await rolesService.personalDataOf(tenant, "nobody")).toEqual([]);
  });
});

describe("permissions", () => {
  const field = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      return error instanceof RolesError ? error.field : String(error);
    }
    return undefined;
  };

  test("setPermissions replaces the set, is idempotent and checks each scope", async () => {
    const api = await resourcesService.createResource(tenant, "svc", {
      uri: "https://api.svc-perm.example/v1",
    });
    const read = await resourcesService.createScope(tenant, {
      name: "read",
      resourceId: api._id.toHexString(),
    });
    const write = await resourcesService.createScope(tenant, {
      name: "write",
      resourceId: api._id.toHexString(),
    });
    const wide = await rolesService.create(tenant, { name: "perm-wide" });
    const wideId = wide._id.toHexString();
    expect(wide.permissionIds).toEqual([]);
    const both = [read._id.toHexString(), write._id.toHexString()];
    const set = await rolesService.setPermissions(tenant, wideId, [
      ...both,
      both[0] ?? "",
    ]);
    expect(set.permissionIds).toEqual([read._id, write._id]);
    const again = await rolesService.setPermissions(tenant, wideId, both);
    expect(again.updatedAt).toEqual(set.updatedAt);
    const replaced = await rolesService.setPermissions(tenant, wideId, [
      both[1] ?? "",
    ]);
    expect(replaced.permissionIds).toEqual([write._id]);
    expect(
      (await rolesService.setPermissions(tenant, wideId, [])).permissionIds,
    ).toEqual([]);

    const own = await rolesService.create(tenant, {
      name: "perm-own",
      resourceId: api._id.toHexString(),
    });
    const ownId = own._id.toHexString();
    expect(
      (await rolesService.setPermissions(tenant, ownId, both)).permissionIds,
    ).toHaveLength(2);
    const otherApi = await resourcesService.createResource(tenant, "svc", {
      uri: "https://api.svc-perm.example/v2",
    });
    const foreign = await resourcesService.createScope(tenant, {
      name: "read",
      resourceId: otherApi._id.toHexString(),
    });
    expect(
      await field(() =>
        rolesService.setPermissions(tenant, ownId, [
          both[0] ?? "",
          foreign._id.toHexString(),
        ]),
      ),
    ).toBe("permissionIds.1");
    const standard = await resourcesService.createScope(tenant, {
      name: "openid",
    });
    expect(
      await field(() =>
        rolesService.setPermissions(tenant, wideId, [
          standard._id.toHexString(),
        ]),
      ),
    ).toBe("permissionIds.0");
    expect(
      await field(() =>
        rolesService.setPermissions(tenant, wideId, [
          new ObjectId().toHexString(),
        ]),
      ),
    ).toBe("permissionIds.0");
    // Another tenant's scope is unknown here.
    expect(
      await code(() =>
        rolesService.setPermissions(other, wideId, [read._id.toHexString()]),
      ),
    ).toBe("NOT_FOUND");
  });

  test("a managed role is refused and an unknown role is not found", async () => {
    const managed = await rolesService.create(tenant, {
      name: "perm-managed",
      managed: true,
    });
    expect(
      await code(() =>
        rolesService.setPermissions(tenant, managed._id.toHexString(), []),
      ),
    ).toBe("ROLE_MANAGED");
    expect(
      await code(() =>
        rolesService.setPermissions(tenant, new ObjectId().toHexString(), []),
      ),
    ).toBe("NOT_FOUND");
  });

  test("pullScopes takes the ids out of the roles that hold them, and only those", async () => {
    const api = await resourcesService.createResource(tenant, "svc", {
      uri: "https://api.svc-pull.example/v1",
    });
    const keep = await resourcesService.createScope(tenant, {
      name: "keep",
      resourceId: api._id.toHexString(),
    });
    const drop = await resourcesService.createScope(tenant, {
      name: "drop",
      resourceId: api._id.toHexString(),
    });
    const holder = await rolesService.create(tenant, { name: "pull-holder" });
    const bystander = await rolesService.create(tenant, { name: "pull-other" });
    await rolesService.setPermissions(tenant, holder._id.toHexString(), [
      keep._id.toHexString(),
      drop._id.toHexString(),
    ]);
    await rolesService.setPermissions(tenant, bystander._id.toHexString(), [
      keep._id.toHexString(),
    ]);
    const changed = await rolesService.pullScopes(tenant, [drop._id]);
    expect(changed.map((r) => r.name)).toEqual(["pull-holder"]);
    expect(
      (await rolesService.find(tenant, holder._id.toHexString()))
        ?.permissionIds,
    ).toEqual([keep._id]);
    expect(await rolesService.pullScopes(tenant, [drop._id])).toEqual([]);
    expect(await rolesService.pullScopes(tenant, [])).toEqual([]);
  });

  test("rolesGranting lists the ids of the roles that hold a scope", async () => {
    const api = await resourcesService.createResource(tenant, "svc", {
      uri: "https://api.svc-granting.example/v1",
    });
    const scope = await resourcesService.createScope(tenant, {
      name: "granted",
      resourceId: api._id.toHexString(),
    });
    const holder = await rolesService.create(tenant, { name: "grant-holder" });
    await rolesService.create(tenant, { name: "grant-other" });
    expect(await rolesService.rolesGranting(tenant, scope._id)).toEqual([]);
    await rolesService.setPermissions(tenant, holder._id.toHexString(), [
      scope._id.toHexString(),
    ]);
    expect(await rolesService.rolesGranting(tenant, scope._id)).toEqual([
      holder._id.toHexString(),
    ]);
    expect(await rolesService.rolesGranting(new ObjectId(), scope._id)).toEqual(
      [],
    );
  });
});
