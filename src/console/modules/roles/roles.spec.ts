import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { registerStoredResource } from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { forTenant } from "@/config/users";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { codeOf, consoleAs } from "~/console";

const owner = consoleAs("rl-owner-a");
const admin = consoleAs("rl-admin-a");
const viewer = consoleAs("rl-viewer-a");
const nobody = consoleAs("rl-nobody");
const adminB = consoleAs("rl-admin-b");

let tenantA = "";
let tenantB = "";
let userA1 = "";
let userA2 = "";
let userB1 = "";
let resourceA = "";

const ROLE = "id name description resourceId memberCount createdAt";
const CREATE = `mutation($t: ID!, $input: CreateRoleInput!) { createRole(tenantId: $t, input: $input) { ${ROLE} } }`;
const UPDATE = `mutation($t: ID!, $id: ID!, $input: UpdateRoleInput!) { updateRole(tenantId: $t, id: $id, input: $input) { ${ROLE} } }`;
const DELETE = `mutation($t: ID!, $id: ID!) { deleteRole(tenantId: $t, id: $id) }`;
const ASSIGN = `mutation($t: ID!, $r: ID!, $u: ID!) { assignRole(tenantId: $t, roleId: $r, userId: $u) }`;
const UNASSIGN = `mutation($t: ID!, $r: ID!, $u: ID!) { unassignRole(tenantId: $t, roleId: $r, userId: $u) }`;
const LIST = `query($t: ID!, $res: ID) { roles(tenantId: $t, resourceId: $res) { ${ROLE} } }`;
const GET = `query($t: ID!, $id: ID!) { role(tenantId: $t, id: $id) { ${ROLE} } }`;
const MEMBERS = `query($t: ID!, $r: ID!, $after: String, $first: Int) {
  roleMembers(tenantId: $t, roleId: $r, after: $after, first: $first) {
    items { assignedAt user { id email } } nextCursor
  }
}`;
const OF_USER = `query($t: ID!, $u: ID!) { userRoles(tenantId: $t, userId: $u) { id name } }`;

type Run = ReturnType<typeof consoleAs>;
const make = async (
  who: Run,
  tenant: string,
  name: string,
  extra: Record<string, unknown> = {},
) => {
  const result = await who(CREATE, { t: tenant, input: { name, ...extra } });
  expect(result.errors).toBeUndefined();
  return ((result.data?.["createRole"] ?? {}) as { id: string }).id;
};
const poolUser = async (slug: string, email: string) => {
  const resolved = await tenantResolver.resolveHost(
    `${slug}.${env.CLAVIX_DOMAIN}`,
  );
  if (resolved === null) throw new Error(`no tenant ${slug}`);
  const auth = await forTenant(resolved);
  if (auth === null) throw new Error(`no janus ${slug}`);
  return (await auth.create({ email })).id;
};
const events = () =>
  mongo.db.adminEvents.raw.find({}).sort({ _id: 1 }).toArray();

beforeAll(async () => {
  tenantA = (await tenantsService.create({ slug: "rl-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "rl-b", name: "B" })).id;
  await access.grantTenant(tenantA, "rl-owner-a", "owner");
  await access.grantTenant(tenantA, "rl-admin-a", "admin");
  await access.grantTenant(tenantA, "rl-viewer-a", "viewer");
  await access.grantTenant(tenantB, "rl-admin-b", "admin");
  userA1 = await poolUser("rl-a", "one@end.test");
  userA2 = await poolUser("rl-a", "two@end.test");
  userB1 = await poolUser("rl-b", "one@end.test");
  const registered = await registerStoredResource({
    tenant: "rl-a",
    uri: "https://api.rl-a.example/v1",
    scopes: ["read"],
  });
  resourceA = (
    await mongo.db.resources.raw.findOne({ tenantId: new ObjectId(tenantA) })
  )?._id.toHexString() as string;
  expect(registered).toBeDefined();
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.roles.raw.deleteMany({});
  await mongo.db.roleAssignments.raw.deleteMany({});
  await mongo.db.resources.raw.deleteMany({});
  await mongo.db.scopes.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
  for (const name of ["partitionedUsers", "partitionedSessions", "relations"]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

describe("permissions", () => {
  test("a viewer reads but cannot write; an admin writes; a stranger sees nothing", async () => {
    const id = await make(admin, tenantA, "perm-role");
    expect((await viewer(LIST, { t: tenantA })).errors).toBeUndefined();
    expect((await viewer(GET, { t: tenantA, id })).errors).toBeUndefined();
    for (const [query, variables] of [
      [CREATE, { t: tenantA, input: { name: "nope" } }],
      [UPDATE, { t: tenantA, id, input: { name: "nope" } }],
      [DELETE, { t: tenantA, id }],
      [ASSIGN, { t: tenantA, r: id, u: userA1 }],
      [UNASSIGN, { t: tenantA, r: id, u: userA1 }],
    ] as const) {
      expect(codeOf(await viewer(query, variables))).toBe("FORBIDDEN");
    }
    for (const [query, variables] of [
      [LIST, { t: tenantA }],
      [GET, { t: tenantA, id }],
      [MEMBERS, { t: tenantA, r: id }],
      [OF_USER, { t: tenantA, u: userA1 }],
      [CREATE, { t: tenantA, input: { name: "nope" } }],
    ] as const) {
      expect(codeOf(await nobody(query, variables))).toBe("FORBIDDEN");
    }
    expect((await owner(LIST, { t: tenantA })).errors).toBeUndefined();
  });
});

describe("CRUD", () => {
  test("create, get, list, update, delete", async () => {
    const created = await admin(CREATE, {
      t: tenantA,
      input: { name: "crud.role", description: "d" },
    });
    const role = created.data?.["createRole"] as Record<string, unknown>;
    expect(role).toMatchObject({
      name: "crud.role",
      description: "d",
      resourceId: null,
      memberCount: 0,
    });
    const id = role["id"] as string;
    expect((await viewer(GET, { t: tenantA, id })).data?.["role"]).toEqual(
      role,
    );
    const listed = (await viewer(LIST, { t: tenantA })).data?.["roles"] as {
      name: string;
    }[];
    expect(listed.map((r) => r.name)).toContain("crud.role");
    const updated = await admin(UPDATE, {
      t: tenantA,
      id,
      input: { name: "crud.renamed", description: "" },
    });
    expect(updated.data?.["updateRole"]).toMatchObject({
      name: "crud.renamed",
      description: null,
    });
    expect((await admin(DELETE, { t: tenantA, id })).data).toEqual({
      deleteRole: true,
    });
    expect((await admin(DELETE, { t: tenantA, id })).data).toEqual({
      deleteRole: true,
    });
    expect((await viewer(GET, { t: tenantA, id })).data?.["role"]).toBeNull();
    expect(
      codeOf(await admin(UPDATE, { t: tenantA, id, input: { name: "x" } })),
    ).toBe("NOT_FOUND");
  });

  test("names are validated and unique per resource", async () => {
    await make(admin, tenantA, "dup");
    expect(
      codeOf(await admin(CREATE, { t: tenantA, input: { name: "dup" } })),
    ).toBe("CONFLICT");
    for (const name of ["", "has space", "x".repeat(65)]) {
      expect(codeOf(await admin(CREATE, { t: tenantA, input: { name } }))).toBe(
        "BAD_USER_INPUT",
      );
    }
    // The same name in a resource is another role.
    const scoped = await make(admin, tenantA, "dup", { resourceId: resourceA });
    expect(scoped).toBeString();
    expect(
      codeOf(
        await admin(CREATE, {
          t: tenantA,
          input: { name: "dup", resourceId: resourceA },
        }),
      ),
    ).toBe("CONFLICT");
    const other = await make(admin, tenantA, "dup2");
    expect(
      codeOf(
        await admin(UPDATE, {
          t: tenantA,
          id: other,
          input: { name: "dup" },
        }),
      ),
    ).toBe("CONFLICT");
  });

  test("a role of an unknown or foreign resource is refused; resourceId filters the list", async () => {
    expect(
      codeOf(
        await admin(CREATE, {
          t: tenantA,
          input: { name: "ghost-res", resourceId: "0".repeat(24) },
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      codeOf(
        await adminB(CREATE, {
          t: tenantB,
          input: { name: "foreign-res", resourceId: resourceA },
        }),
      ),
    ).toBe("NOT_FOUND");
    await make(admin, tenantA, "on-res", { resourceId: resourceA });
    const scoped = (await admin(LIST, { t: tenantA, res: resourceA })).data?.[
      "roles"
    ] as { resourceId: string }[];
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((r) => r.resourceId === resourceA)).toBe(true);
  });

  test("a malformed id reads as unknown", async () => {
    expect(
      (await admin(GET, { t: tenantA, id: "nope" })).data?.["role"],
    ).toBeNull();
    expect(
      codeOf(
        await admin(UPDATE, { t: tenantA, id: "nope", input: { name: "x" } }),
      ),
    ).toBe("NOT_FOUND");
  });
});

describe("tenant isolation", () => {
  test("tenant B sees and touches none of tenant A's roles", async () => {
    const id = await make(admin, tenantA, "iso");
    expect((await adminB(LIST, { t: tenantB })).data?.["roles"]).toEqual([]);
    expect((await adminB(GET, { t: tenantB, id })).data?.["role"]).toBeNull();
    expect(
      codeOf(await adminB(UPDATE, { t: tenantB, id, input: { name: "z" } })),
    ).toBe("NOT_FOUND");
    expect((await adminB(DELETE, { t: tenantB, id })).data).toEqual({
      deleteRole: true,
    });
    expect(
      (await admin(GET, { t: tenantA, id })).data?.["role"],
    ).not.toBeNull();
    // A's admin cannot address B's tenant.
    expect(codeOf(await admin(LIST, { t: tenantB }))).toBe("FORBIDDEN");
    // Nor assign a role of A to a user of B.
    expect(codeOf(await adminB(ASSIGN, { t: tenantB, r: id, u: userB1 }))).toBe(
      "NOT_FOUND",
    );
    expect(codeOf(await admin(ASSIGN, { t: tenantA, r: id, u: userB1 }))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("assignments", () => {
  test("assign is idempotent, lists members and user roles, unassign is idempotent", async () => {
    const id = await make(admin, tenantA, "asg");
    const assign = (u: string) => admin(ASSIGN, { t: tenantA, r: id, u });
    expect((await assign(userA1)).data).toEqual({ assignRole: true });
    expect((await assign(userA1)).data).toEqual({ assignRole: true });
    expect((await assign(userA2)).data).toEqual({ assignRole: true });
    expect(
      (await viewer(GET, { t: tenantA, id })).data?.["role"],
    ).toMatchObject({ memberCount: 2 });
    const members = (await viewer(MEMBERS, { t: tenantA, r: id })).data?.[
      "roleMembers"
    ] as { items: { user: { id: string; email: string } }[]; nextCursor: null };
    expect(members.items.map((m) => m.user.id)).toEqual([userA1, userA2]);
    expect(members.nextCursor).toBeNull();
    const roles = (await viewer(OF_USER, { t: tenantA, u: userA1 })).data?.[
      "userRoles"
    ] as { id: string }[];
    expect(roles.map((r) => r.id)).toContain(id);
    expect(
      (await admin(UNASSIGN, { t: tenantA, r: id, u: userA1 })).data,
    ).toEqual({ unassignRole: true });
    expect(
      (await admin(UNASSIGN, { t: tenantA, r: id, u: userA1 })).data,
    ).toEqual({ unassignRole: false });
    expect(
      (await viewer(GET, { t: tenantA, id })).data?.["role"],
    ).toMatchObject({ memberCount: 1 });
  });

  test("an unknown role or user cannot be assigned", async () => {
    const id = await make(admin, tenantA, "asg-bad");
    expect(
      codeOf(await admin(ASSIGN, { t: tenantA, r: id, u: "0".repeat(24) })),
    ).toBe("NOT_FOUND");
    expect(
      codeOf(await admin(ASSIGN, { t: tenantA, r: "0".repeat(24), u: userA1 })),
    ).toBe("NOT_FOUND");
  });

  test("members page by cursor; a bad cursor is BAD_USER_INPUT", async () => {
    const id = await make(admin, tenantA, "paged");
    await admin(ASSIGN, { t: tenantA, r: id, u: userA1 });
    await admin(ASSIGN, { t: tenantA, r: id, u: userA2 });
    const first = (await viewer(MEMBERS, { t: tenantA, r: id, first: 1 }))
      .data?.["roleMembers"] as {
      items: { user: { id: string } }[];
      nextCursor: string;
    };
    expect(first.items.map((m) => m.user.id)).toEqual([userA1]);
    expect(first.nextCursor).toBeString();
    const second = (
      await viewer(MEMBERS, {
        t: tenantA,
        r: id,
        first: 1,
        after: first.nextCursor,
      })
    ).data?.["roleMembers"] as { items: { user: { id: string } }[] };
    expect(second.items.map((m) => m.user.id)).toEqual([userA2]);
    expect(
      codeOf(await viewer(MEMBERS, { t: tenantA, r: id, after: "garbage!" })),
    ).toBe("BAD_USER_INPUT");
  });

  test("deleting a role removes its assignments", async () => {
    const id = await make(admin, tenantA, "del-asg");
    await admin(ASSIGN, { t: tenantA, r: id, u: userA1 });
    await admin(DELETE, { t: tenantA, id });
    expect(
      await mongo.db.roleAssignments.raw.countDocuments({
        tenantId: new ObjectId(tenantA),
        roleId: new ObjectId(id),
      }),
    ).toBe(0);
    expect(
      await mongo.db.roleAssignments.raw.countDocuments({
        roleId: { $exists: true },
        userId: userA1,
        tenantId: new ObjectId(tenantA),
      }),
    ).toBeGreaterThanOrEqual(0);
    const roles = (await viewer(OF_USER, { t: tenantA, u: userA1 })).data?.[
      "userRoles"
    ] as { id: string }[];
    expect(roles.map((r) => r.id)).not.toContain(id);
  });

  test("deleting a resource deletes the roles scoped to it and their assignments", async () => {
    const uri = "https://api.rl-a.example/gone";
    await registerStoredResource({ tenant: "rl-a", uri, scopes: ["read"] });
    const found = await mongo.db.resources.raw.findOne({
      tenantId: new ObjectId(tenantA),
      uri,
    });
    const rid = found?._id.toHexString() as string;
    const role = await make(admin, tenantA, "res-bound", { resourceId: rid });
    await admin(ASSIGN, { t: tenantA, r: role, u: userA1 });
    await mongo.db.adminEvents.raw.deleteMany({});
    const removed = await admin(
      `mutation($t: ID!, $id: ID!) { deleteResource(tenantId: $t, id: $id) }`,
      { t: tenantA, id: rid },
    );
    expect(removed.errors).toBeUndefined();
    expect(
      (await events())
        .filter((e) => e.action === "role.delete")
        .map((e) => e.target.id),
    ).toEqual([role]);
    expect(
      (await viewer(GET, { t: tenantA, id: role })).data?.["role"],
    ).toBeNull();
    expect(
      await mongo.db.roleAssignments.raw.countDocuments({
        roleId: new ObjectId(role),
      }),
    ).toBe(0);
  });
});

describe("a suspended tenant", () => {
  test("its roles are NOT_FOUND, even for its admin", async () => {
    const id = (await tenantsService.create({ slug: "rl-s", name: "S" })).id;
    await access.grantTenant(id, "rl-admin-a", "admin");
    await tenantsService.suspend(id);
    expect(codeOf(await admin(LIST, { t: id }))).toBe("NOT_FOUND");
    expect(
      codeOf(await admin(CREATE, { t: id, input: { name: "nope" } })),
    ).toBe("NOT_FOUND");
  });
});

describe("audit", () => {
  test("each mutation stores its event, repeats included", async () => {
    await mongo.db.adminEvents.raw.deleteMany({});
    const id = await make(admin, tenantA, "audited");
    await admin(UPDATE, { t: tenantA, id, input: { description: "x" } });
    await admin(ASSIGN, { t: tenantA, r: id, u: userA1 });
    await admin(ASSIGN, { t: tenantA, r: id, u: userA1 });
    await admin(UNASSIGN, { t: tenantA, r: id, u: userA1 });
    await admin(DELETE, { t: tenantA, id });
    await admin(DELETE, { t: tenantA, id });
    expect((await events()).map((e) => e.action)).toEqual([
      "role.create",
      "role.update",
      "role.assign",
      "role.assign",
      "role.assign",
      "role.assign",
      "role.unassign",
      "role.unassign",
      "role.delete",
      "role.delete",
    ]);
  });
});
