import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { at } from "~/body";
import { codeOf, consoleAs } from "~/console";

const owner = consoleAs("ua-owner-a");
const admin = consoleAs("ua-admin-a");
const viewer = consoleAs("ua-viewer-a");
const nobody = consoleAs("ua-nobody");
const adminB = consoleAs("ua-admin-b");

let tenantA = "";
let tenantB = "";

const FIELDS =
  "id key family type label { locale text } description { locale text } unit options { key label { locale text } } required userEditable unique emissionScope archivedAt valueCount roles { required } version";
const CREATE = `mutation($t: ID!, $input: CreateUserAttributeInput!) { createUserAttribute(tenantId: $t, input: $input) { ${FIELDS} } }`;
const UPDATE = `mutation($t: ID!, $id: ID!, $v: Int!, $input: UpdateUserAttributeInput!) { updateUserAttribute(tenantId: $t, id: $id, version: $v, input: $input) { ${FIELDS} } }`;
const MOVE = `mutation($t: ID!, $id: ID!, $p: Int!) { moveUserAttribute(tenantId: $t, id: $id, position: $p) { id key } }`;
const ARCHIVE = `mutation($t: ID!, $id: ID!) { archiveUserAttribute(tenantId: $t, id: $id) { ${FIELDS} } }`;
const RESTORE = `mutation($t: ID!, $id: ID!) { restoreUserAttribute(tenantId: $t, id: $id) { ${FIELDS} } }`;
const DELETE = `mutation($t: ID!, $id: ID!, $k: String!) { deleteUserAttribute(tenantId: $t, id: $id, confirmKey: $k) }`;
const LIST = `query($t: ID!, $f: AttributeFamily, $a: Boolean) { userAttributes(tenantId: $t, family: $f, archived: $a) { ${FIELDS} } }`;
const GET = `query($t: ID!, $id: ID!) { userAttribute(tenantId: $t, id: $id) { ${FIELDS} } }`;

const shown = z.looseObject({
  id: z.string(),
  key: z.string(),
  version: z.number(),
});
const label = [{ locale: "en", text: "Label" }];
const input = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  family: "USER",
  type: "STRING",
  label,
  ...extra,
});

type Run = ReturnType<typeof consoleAs>;
const make = async (who: Run, tenant: string, key: string, extra = {}) => {
  const result = await who(CREATE, { t: tenant, input: input(key, extra) });
  expect(result.errors).toBeUndefined();
  return at(result.data, "createUserAttribute", shown);
};
const events = () =>
  mongo.db.adminEvents.raw.find({}).sort({ _id: 1 }).toArray();

beforeAll(async () => {
  tenantA = (await tenantsService.create({ slug: "ua-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "ua-b", name: "B" })).id;
  await access.grantTenant(tenantA, "ua-owner-a", "owner");
  await access.grantTenant(tenantA, "ua-admin-a", "admin");
  await access.grantTenant(tenantA, "ua-viewer-a", "viewer");
  await access.grantTenant(tenantB, "ua-admin-b", "admin");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.userAttributes.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
});

describe("permissions", () => {
  test("a viewer reads and cannot write; an admin cannot delete for good; a stranger sees nothing", async () => {
    const made = await make(admin, tenantA, "perm_attr");
    expect((await viewer(LIST, { t: tenantA })).errors).toBeUndefined();
    expect(
      (await viewer(GET, { t: tenantA, id: made.id })).errors,
    ).toBeUndefined();
    for (const [query, variables] of [
      [CREATE, { t: tenantA, input: input("nope_attr") }],
      [UPDATE, { t: tenantA, id: made.id, v: made.version, input: {} }],
      [MOVE, { t: tenantA, id: made.id, p: 0 }],
      [ARCHIVE, { t: tenantA, id: made.id }],
      [RESTORE, { t: tenantA, id: made.id }],
      [DELETE, { t: tenantA, id: made.id, k: "perm_attr" }],
    ] as const) {
      expect(codeOf(await viewer(query, variables))).toBe("FORBIDDEN");
    }
    await admin(ARCHIVE, { t: tenantA, id: made.id });
    expect(
      codeOf(await admin(DELETE, { t: tenantA, id: made.id, k: "perm_attr" })),
    ).toBe("FORBIDDEN");
    for (const [query, variables] of [
      [LIST, { t: tenantA }],
      [GET, { t: tenantA, id: made.id }],
      [CREATE, { t: tenantA, input: input("nope_attr") }],
    ] as const) {
      expect(codeOf(await nobody(query, variables))).toBe("FORBIDDEN");
    }
    expect(
      (await owner(DELETE, { t: tenantA, id: made.id, k: "perm_attr" })).data,
    ).toEqual({
      deleteUserAttribute: true,
    });
  });
});

describe("catalogue", () => {
  test("create, get, list, update, move, archive, restore, delete", async () => {
    const created = await admin(CREATE, {
      t: tenantA,
      input: input("crud_size", {
        type: "NUMBER",
        unit: "cm",
        description: [{ locale: "en", text: "Height" }],
      }),
    });
    expect(created.errors).toBeUndefined();
    const attribute = at(created.data, "createUserAttribute", shown);
    expect(attribute).toMatchObject({
      key: "crud_size",
      family: "USER",
      type: "NUMBER",
      unit: "cm",
      required: false,
      userEditable: false,
      unique: false,
      emissionScope: null,
      archivedAt: null,
      valueCount: 0,
      roles: [],
    });
    await make(admin, tenantA, "crud_other");
    expect(
      (await viewer(GET, { t: tenantA, id: attribute.id })).data?.[
        "userAttribute"
      ],
    ).toEqual(attribute);
    const listed = at(
      (await viewer(LIST, { t: tenantA, f: "USER" })).data,
      "userAttributes",
      z.array(shown),
    );
    expect(
      listed.map((a) => a.key).filter((k) => k.startsWith("crud_")),
    ).toEqual(["crud_size", "crud_other"]);
  });

  test("update refuses a stale version and move reorders the family", async () => {
    const attribute = at(
      (
        await admin(CREATE, {
          t: tenantA,
          input: input("upd_size", { type: "NUMBER" }),
        })
      ).data,
      "createUserAttribute",
      shown,
    );
    const second = await make(admin, tenantA, "upd_other");
    const updated = await admin(UPDATE, {
      t: tenantA,
      id: attribute.id,
      v: attribute.version,
      input: { required: true, label: [{ locale: "fr", text: "Taille" }] },
    });
    const next = at(updated.data, "updateUserAttribute", shown);
    expect(next.version).toBeGreaterThan(attribute.version);
    expect(next).toMatchObject({ required: true });
    expect(
      codeOf(
        await admin(UPDATE, {
          t: tenantA,
          id: attribute.id,
          v: attribute.version,
          input: {},
        }),
      ),
    ).toBe("CONFLICT");

    await admin(MOVE, { t: tenantA, id: second.id, p: 0 });
    const moved = at(
      (await viewer(LIST, { t: tenantA })).data,
      "userAttributes",
      z.array(shown),
    ).filter((a) => a.key.startsWith("upd_"));
    expect(moved.map((a) => a.key)).toEqual(["upd_other", "upd_size"]);
  });

  test("archive, restore and the permanent delete", async () => {
    const attribute = at(
      (await admin(CREATE, { t: tenantA, input: input("arc_size") })).data,
      "createUserAttribute",
      shown,
    );
    const archived = await admin(ARCHIVE, { t: tenantA, id: attribute.id });
    expect(archived.data?.["archiveUserAttribute"]).toMatchObject({
      key: "arc_size",
    });
    expect(
      at(
        (await viewer(LIST, { t: tenantA, a: true })).data,
        "userAttributes",
        z.array(shown),
      ).map((a) => a.key),
    ).toContain("arc_size");
    expect(
      codeOf(await admin(CREATE, { t: tenantA, input: input("arc_size") })),
    ).toBe("ATTRIBUTE_KEY_TAKEN");
    const restored = await admin(RESTORE, { t: tenantA, id: attribute.id });
    expect(restored.data?.["restoreUserAttribute"]).toMatchObject({
      archivedAt: null,
    });

    expect(
      codeOf(
        await owner(DELETE, { t: tenantA, id: attribute.id, k: "arc_size" }),
      ),
    ).toBe("ATTRIBUTE_NOT_ARCHIVED");
    await admin(ARCHIVE, { t: tenantA, id: attribute.id });
    expect(
      codeOf(await owner(DELETE, { t: tenantA, id: attribute.id, k: "other" })),
    ).toBe("ATTRIBUTE_DELETE_UNCONFIRMED");
    for (let i = 0; i < 2; i += 1) {
      expect(
        (await owner(DELETE, { t: tenantA, id: attribute.id, k: "arc_size" }))
          .data,
      ).toEqual({
        deleteUserAttribute: true,
      });
    }
    expect(
      (await viewer(GET, { t: tenantA, id: attribute.id })).data?.[
        "userAttribute"
      ],
    ).toBeNull();
  });

  test("the refusals reach the client with their codes", async () => {
    for (const [extra, key, expected] of [
      [{}, "Bad", "ATTRIBUTE_KEY_INVALID"],
      [{}, "email", "ATTRIBUTE_KEY_RESERVED"],
      [
        { type: "BOOLEAN", unique: true },
        "ref_unique",
        "ATTRIBUTE_UNIQUE_UNSUPPORTED",
      ],
      [
        { emissionScope: "openid", userEditable: true },
        "ref_emit",
        "ATTRIBUTE_EDITABLE_EMITTED",
      ],
      [{ emissionScope: "unknown" }, "ref_scope", "ATTRIBUTE_SCOPE_UNKNOWN"],
      [{ label: [] }, "ref_label", "BAD_USER_INPUT"],
    ] as const) {
      expect(
        codeOf(await admin(CREATE, { t: tenantA, input: input(key, extra) })),
      ).toBe(expected);
    }
  });

  test("a tenant never sees another's attributes", async () => {
    const mine = await make(admin, tenantA, "iso_attr");
    expect(
      (await adminB(GET, { t: tenantB, id: mine.id })).data?.["userAttribute"],
    ).toBeNull();
    expect(codeOf(await adminB(ARCHIVE, { t: tenantB, id: mine.id }))).toBe(
      "NOT_FOUND",
    );
    expect(codeOf(await adminB(LIST, { t: tenantA }))).toBe("FORBIDDEN");
    const theirs = at(
      (await adminB(LIST, { t: tenantB })).data,
      "userAttributes",
      z.array(shown),
    );
    expect(theirs).toEqual([]);
    expect((await make(adminB, tenantB, "iso_attr")).id).not.toBe(mine.id);
  });
});

describe("audit trail", () => {
  test("each change records one event with ids only", async () => {
    await mongo.db.adminEvents.raw.deleteMany({});
    const made = await make(admin, tenantA, "audit_attr");
    await admin(UPDATE, {
      t: tenantA,
      id: made.id,
      v: made.version,
      input: { required: true },
    });
    await admin(MOVE, { t: tenantA, id: made.id, p: 0 });
    await admin(ARCHIVE, { t: tenantA, id: made.id });
    await admin(RESTORE, { t: tenantA, id: made.id });
    await admin(ARCHIVE, { t: tenantA, id: made.id });
    await owner(DELETE, { t: tenantA, id: made.id, k: "audit_attr" });
    const recorded = await events();
    expect(recorded.map((e) => e.action)).toEqual([
      "userAttribute.create",
      "userAttribute.update",
      "userAttribute.move",
      "userAttribute.archive",
      "userAttribute.restore",
      "userAttribute.archive",
      "userAttribute.delete",
    ]);
    for (const event of recorded) {
      expect(event.target).toEqual({ type: "userAttribute", id: made.id });
      expect(String(event.tenantId)).toBe(tenantA);
    }
    expect(JSON.stringify(recorded)).not.toContain("Label");
  });
});
