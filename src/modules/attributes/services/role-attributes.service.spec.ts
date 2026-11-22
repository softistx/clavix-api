import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  attributesService as catalogue,
  roleAttributesService as links,
  attributeValuesService as values,
} from "@/config/attributes";
import { mongo } from "@/config/db";
import { rolesService } from "@/config/roles";
import { extensionCodeOf } from "@/shared/errors";
import { defined } from "~/narrow";
import type { ValueChange } from "../values.types";

const tenant = new ObjectId();
const other = new ObjectId();
const admin = { kind: "admin", id: "admin-1" } as const;
const label = [{ locale: "en", text: "Label" }];

const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return String(extensionCodeOf(error));
  }
  return undefined;
};

const roleAttribute = (key: string, extra: Record<string, unknown> = {}) =>
  catalogue.create(tenant, {
    key,
    family: "ROLE",
    type: "STRING",
    label,
    ...extra,
  });

const set = (attributeId: ObjectId, text: string): ValueChange => ({
  attributeId: attributeId.toHexString(),
  value: { text },
});

/** Saves one role section the way the console does: the held links are read first. */
const saveSection = async (
  userId: string,
  roleId: ObjectId,
  changes: ValueChange[],
) =>
  values.save(tenant, userId, changes, admin, true, {
    family: "ROLE",
    links: await links.linksHeld(tenant, userId, roleId.toHexString()),
  });

afterAll(async () => {
  for (const tenantId of [tenant, other]) {
    await mongo.db.roleAttributes.raw.deleteMany({ tenantId });
    await mongo.db.attributeValues.raw.deleteMany({ tenantId });
    await mongo.db.userAttributes.raw.deleteMany({ tenantId });
    await mongo.db.roleAssignments.raw.deleteMany({ tenantId });
    await mongo.db.roles.raw.deleteMany({ tenantId });
  }
});

describe("linking", () => {
  test("assign is idempotent and a repeat sets required", async () => {
    const role = await rolesService.create(tenant, { name: "ra-doctor" });
    const attr = await roleAttribute("ra_licence");
    const first = await links.assign(
      tenant,
      role.id,
      attr._id.toHexString(),
      false,
    );
    expect(first._id).toEqual(attr._id);
    await links.assign(tenant, role.id, attr._id.toHexString(), true);
    const stored = await mongo.db.roleAttributes.raw
      .find({ tenantId: tenant, roleId: role._id })
      .toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.required).toBe(true);
    await links.update(tenant, role.id, attr._id.toHexString(), false);
    expect(
      (
        await mongo.db.roleAttributes.raw.findOne({
          tenantId: tenant,
          roleId: role._id,
        })
      )?.required,
    ).toBe(false);
  });

  test("a user attribute, an archived one, unknown ids and another tenant are refused", async () => {
    const role = await rolesService.create(tenant, { name: "ra-nurse" });
    const user = await catalogue.create(tenant, {
      key: "ra_user",
      family: "USER",
      type: "STRING",
      label,
    });
    const old = await roleAttribute("ra_old");
    await catalogue.archive(tenant, old.id);
    const live = await roleAttribute("ra_live");
    const hex = (id: ObjectId) => id.toHexString();
    expect(
      await code(() => links.assign(tenant, role.id, hex(user._id), false)),
    ).toBe("ATTRIBUTE_FAMILY_MISMATCH");
    expect(
      await code(() => links.assign(tenant, role.id, hex(old._id), false)),
    ).toBe("ATTRIBUTE_ARCHIVED");
    expect(
      await code(() =>
        links.assign(
          tenant,
          new ObjectId().toHexString(),
          hex(live._id),
          false,
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await code(() =>
        links.assign(tenant, role.id, new ObjectId().toHexString(), false),
      ),
    ).toBe("NOT_FOUND");
    expect(await code(() => links.assign(tenant, role.id, "nope", false))).toBe(
      "NOT_FOUND",
    );
    expect(
      await code(() => links.assign(other, role.id, hex(live._id), false)),
    ).toBe("NOT_FOUND");
    expect(
      await code(() => links.update(tenant, role.id, hex(live._id), true)),
    ).toBe("NOT_FOUND");
  });

  test("unassign is idempotent and says whether a link was there", async () => {
    const role = await rolesService.create(tenant, { name: "ra-clerk" });
    const attr = await roleAttribute("ra_badge");
    const id = attr._id.toHexString();
    await links.assign(tenant, role.id, id, false);
    expect(await links.unassign(other, role.id, id)).toBe(false);
    expect(await links.unassign(tenant, role.id, id)).toBe(true);
    expect(await links.unassign(tenant, role.id, id)).toBe(false);
    expect(await links.unassign(tenant, "bad", id)).toBe(false);
  });

  test("linksOf lists each attribute's roles by name, and only role attributes", async () => {
    const b = await rolesService.create(tenant, { name: "ra-lb" });
    const a = await rolesService.create(tenant, { name: "ra-la" });
    const attr = await roleAttribute("ra_listed");
    await links.assign(tenant, b.id, attr._id.toHexString(), true);
    await links.assign(tenant, a.id, attr._id.toHexString(), false);
    const found = await links.linksOf(tenant, [attr]);
    expect(
      found.get(attr._id.toHexString())?.map((l) => [l.role.name, l.required]),
    ).toEqual([
      ["ra-la", false],
      ["ra-lb", true],
    ]);
    expect(await links.linksOf(tenant, [])).toEqual(new Map());
  });

  test("deleting a role, or an attribute, sweeps its links", async () => {
    const role = await rolesService.create(tenant, { name: "ra-sweep" });
    const keep = await rolesService.create(tenant, { name: "ra-keep" });
    const a = await roleAttribute("ra_sw_a");
    const b = await roleAttribute("ra_sw_b");
    for (const r of [role, keep])
      for (const x of [a, b])
        await links.assign(tenant, r.id, x._id.toHexString(), false);
    await rolesService.delete(tenant, role.id);
    expect(
      await mongo.db.roleAttributes.raw.countDocuments({
        tenantId: tenant,
        roleId: role._id,
      }),
    ).toBe(0);
    await catalogue.archive(tenant, b.id);
    await catalogue.delete(tenant, b.id, "ra_sw_b");
    expect(
      await mongo.db.roleAttributes.raw.countDocuments({
        tenantId: tenant,
        attributeId: b._id,
      }),
    ).toBe(0);
    expect(
      await mongo.db.roleAttributes.raw.countDocuments({
        tenantId: tenant,
        roleId: keep._id,
        attributeId: a._id,
      }),
    ).toBe(1);
  });
});

describe("races", () => {
  test("a role deleted while assigning leaves no link", async () => {
    const role = await rolesService.create(tenant, { name: "ra-race-role" });
    const attr = await roleAttribute("ra_race_role");
    const raw = mongo.db.roleAttributes.raw;
    const insert = raw.insertOne.bind(raw);
    const spy = spyOn(raw, "insertOne").mockImplementation(async (...args) => {
      const made = await insert(...args);
      await mongo.db.roles.raw.deleteOne({ _id: role._id });
      return made;
    });
    try {
      expect(
        await code(() =>
          links.assign(tenant, role.id, attr._id.toHexString(), false),
        ),
      ).toBe("NOT_FOUND");
    } finally {
      spy.mockRestore();
    }
    expect(
      await mongo.db.roleAttributes.raw.countDocuments({
        tenantId: tenant,
        attributeId: attr._id,
      }),
    ).toBe(0);
  });

  test("an attribute deleted while assigning leaves no link", async () => {
    const role = await rolesService.create(tenant, { name: "ra-race-attr" });
    const attr = await roleAttribute("ra_race_attr");
    const raw = mongo.db.roleAttributes.raw;
    const insert = raw.insertOne.bind(raw);
    const spy = spyOn(raw, "insertOne").mockImplementation(async (...args) => {
      const made = await insert(...args);
      await mongo.db.userAttributes.raw.deleteOne({ _id: attr._id });
      return made;
    });
    try {
      expect(
        await code(() =>
          links.assign(tenant, role.id, attr._id.toHexString(), false),
        ),
      ).toBe("NOT_FOUND");
    } finally {
      spy.mockRestore();
    }
    expect(
      await mongo.db.roleAttributes.raw.countDocuments({
        tenantId: tenant,
        roleId: role._id,
      }),
    ).toBe(0);
  });
});

describe("role sections and hiding", () => {
  test("a user sees a section per held role that links a live attribute", async () => {
    const held = await rolesService.create(tenant, { name: "ra-sec-held" });
    const bare = await rolesService.create(tenant, { name: "ra-sec-bare" });
    const absent = await rolesService.create(tenant, { name: "ra-sec-absent" });
    const attr = await roleAttribute("ra_sec");
    const id = attr._id.toHexString();
    await links.assign(tenant, held.id, id, true);
    await links.assign(tenant, absent.id, id, false);
    await rolesService.assign(tenant, held.id, "s1");
    await rolesService.assign(tenant, bare.id, "s1");
    const sections = await links.sectionsOf(tenant, ["s1", "s2"]);
    expect(sections.has("s2")).toBe(false);
    const own = defined(sections.get("s1"));
    expect(own.map((s) => s.role.name)).toEqual(["ra-sec-held"]);
    expect(own[0]?.items.map((i) => [i.attribute.key, i.required])).toEqual([
      ["ra_sec", true],
    ]);
    expect(await links.sectionsOf(tenant, [])).toEqual(new Map());
    expect((await links.sectionsOf(other, ["s1"])).size).toBe(0);
  });

  test("linksHeld refuses a role the user does not hold", async () => {
    const role = await rolesService.create(tenant, { name: "ra-nothold" });
    expect(await code(() => links.linksHeld(tenant, "h1", role.id))).toBe(
      "ATTRIBUTE_ROLE_NOT_HELD",
    );
    expect(
      await code(() =>
        links.linksHeld(tenant, "h1", new ObjectId().toHexString()),
      ),
    ).toBe("ATTRIBUTE_ROLE_NOT_HELD");
    expect(await code(() => links.linksHeld(tenant, "h1", "bad"))).toBe(
      "ATTRIBUTE_ROLE_NOT_HELD",
    );
    await rolesService.assign(tenant, role.id, "h1");
    expect((await links.linksHeld(tenant, "h1", role.id)).size).toBe(0);
  });

  test("a value is shared by two roles that link its attribute", async () => {
    const r1 = await rolesService.create(tenant, { name: "ra-sh-1" });
    const r2 = await rolesService.create(tenant, { name: "ra-sh-2" });
    const attr = await roleAttribute("ra_shared");
    const id = attr._id.toHexString();
    await links.assign(tenant, r1.id, id, false);
    await links.assign(tenant, r2.id, id, false);
    await rolesService.assign(tenant, r1.id, "sh1");
    await rolesService.assign(tenant, r2.id, "sh1");
    await saveSection("sh1", r1._id, [set(attr._id, "first")]);
    await saveSection("sh1", r2._id, [set(attr._id, "second")]);
    expect(await values.count(tenant, attr._id)).toBe(1);
    const exported = await values.personalDataOf(tenant, "sh1");
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      value: "second",
      hidden: false,
      roles: ["ra-sh-1", "ra-sh-2"],
    });
  });

  test("removing the role hides the value, re-assigning shows it, nothing is written", async () => {
    const role = await rolesService.create(tenant, { name: "ra-hide" });
    const attr = await roleAttribute("ra_hidden");
    await links.assign(tenant, role.id, attr._id.toHexString(), false);
    await rolesService.assign(tenant, role.id, "hd1");
    await saveSection("hd1", role._id, [set(attr._id, "kept")]);
    const before = await mongo.db.attributeValues.raw.findOne({
      tenantId: tenant,
      userId: "hd1",
    });
    await rolesService.unassign(tenant, role.id, "hd1");
    expect(await links.sectionsOf(tenant, ["hd1"])).toEqual(new Map());
    const hidden = await values.personalDataOf(tenant, "hd1");
    expect(hidden[0]).toMatchObject({ value: "kept", hidden: true, roles: [] });
    expect(
      await mongo.db.attributeValues.raw.findOne({
        tenantId: tenant,
        userId: "hd1",
      }),
    ).toEqual(before);
    await rolesService.assign(tenant, role.id, "hd1");
    const shown = await values.personalDataOf(tenant, "hd1");
    expect(shown[0]).toMatchObject({ value: "kept", hidden: false });
    expect(shown[0]?.roles).toEqual(["ra-hide"]);
  });

  test("a section saves only what its role links, and a user attribute is refused there", async () => {
    const role = await rolesService.create(tenant, { name: "ra-only" });
    const linked = await roleAttribute("ra_linked");
    const unlinked = await roleAttribute("ra_unlinked");
    const user = await catalogue.create(tenant, {
      key: "ra_general",
      family: "USER",
      type: "STRING",
      label,
    });
    await links.assign(tenant, role.id, linked._id.toHexString(), false);
    await rolesService.assign(tenant, role.id, "o1");
    for (const attr of [unlinked, user])
      expect(
        await code(() => saveSection("o1", role._id, [set(attr._id, "x")])),
      ).toBe("ATTRIBUTE_FAMILY_MISMATCH");
    // A role attribute is refused in the general section too.
    expect(
      await code(() =>
        values.save(tenant, "o1", [set(linked._id, "x")], admin, true),
      ),
    ).toBe("ATTRIBUTE_FAMILY_MISMATCH");
    expect(
      (await saveSection("o1", role._id, [set(linked._id, "ok")])).length,
    ).toBe(1);
  });

  test("a required link blocks a clear in that role only", async () => {
    const role = await rolesService.create(tenant, { name: "ra-req" });
    const attr = await roleAttribute("ra_req");
    await links.assign(tenant, role.id, attr._id.toHexString(), true);
    await rolesService.assign(tenant, role.id, "rq1");
    await saveSection("rq1", role._id, [set(attr._id, "x")]);
    expect(
      await code(() =>
        saveSection("rq1", role._id, [
          { attributeId: attr._id.toHexString(), value: null },
        ]),
      ),
    ).toBe("ATTRIBUTE_REQUIRED");
  });
});

describe("incomplete accounts", () => {
  const setup = async (key: string) => {
    const role = await rolesService.create(tenant, { name: `${key}-role` });
    const attr = await roleAttribute(key);
    await links.assign(tenant, role.id, attr._id.toHexString(), true);
    return { role, attr };
  };

  test("a held role with a required link and no value is incomplete", async () => {
    const { role } = await setup("inc_none");
    await rolesService.assign(tenant, role.id, "inc-u1");
    expect([...(await values.incomplete(tenant, ["inc-u1"]))]).toEqual([
      "inc-u1",
    ]);
  });

  test("a value set makes the user complete", async () => {
    const { role, attr } = await setup("inc_set");
    await rolesService.assign(tenant, role.id, "inc-u2");
    await rolesService.assign(tenant, role.id, "inc-u3");
    await saveSection("inc-u2", role._id, [set(attr._id, "x")]);
    const missing = await values.incomplete(tenant, ["inc-u2", "inc-u3"]);
    expect([...missing]).toEqual(["inc-u3"]);
  });

  test("a role the user does not hold is ignored", async () => {
    await setup("inc_notheld");
    expect([...(await values.incomplete(tenant, ["inc-nobody"]))]).toEqual([]);
  });

  test("an archived attribute is ignored", async () => {
    const { role, attr } = await setup("inc_arch");
    await rolesService.assign(tenant, role.id, "inc-u4");
    await catalogue.archive(tenant, attr._id.toHexString());
    expect([...(await values.incomplete(tenant, ["inc-u4"]))]).toEqual([]);
  });

  test("an optional link is ignored", async () => {
    const role = await rolesService.create(tenant, { name: "inc-opt-role" });
    const attr = await roleAttribute("inc_opt");
    await links.assign(tenant, role.id, attr._id.toHexString(), false);
    await rolesService.assign(tenant, role.id, "inc-u5");
    expect([...(await values.incomplete(tenant, ["inc-u5"]))]).toEqual([]);
  });
});
