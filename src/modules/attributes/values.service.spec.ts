import { afterAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { extensionCodeOf } from "@/shared/errors";
import { defined } from "~/narrow";
import type { AttributeType } from "./attributes.model";
import { AttributesService } from "./attributes.service";
import { AttributeValuesService } from "./values.service";

const tenant = new ObjectId();
const other = new ObjectId();
const values = new AttributeValuesService({
  values: mongo.db.attributeValues,
  attributes: mongo.db.userAttributes,
});
const catalogue = new AttributesService({
  attributes: mongo.db.userAttributes,
  scopes: mongo.db.scopes,
  values,
  clock: () => new Date("2026-01-02T03:04:05.000Z"),
});
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

const make = (
  key: string,
  type: AttributeType = "STRING",
  extra: Record<string, unknown> = {},
  tenantId = tenant,
) =>
  catalogue.create(tenantId, {
    key,
    family: "USER",
    type,
    label,
    ...extra,
  });

const set = (attributeId: ObjectId, value: Record<string, unknown>) => ({
  attributeId: attributeId.toHexString(),
  value,
});
const clear = (attributeId: ObjectId) => ({
  attributeId: attributeId.toHexString(),
  value: null,
});

afterAll(async () => {
  for (const tenantId of [tenant, other]) {
    await mongo.db.attributeValues.raw.deleteMany({ tenantId });
    await mongo.db.userAttributes.raw.deleteMany({ tenantId });
  }
});

describe("saving values", () => {
  test("sets, replaces and clears a value, and tells who wrote it", async () => {
    const nick = await make("v_nick");
    const age = await make("v_age", "NUMBER");
    const saved = await values.save(
      tenant,
      "u1",
      [set(nick._id, { text: " Ada " }), set(age._id, { number: 36 })],
      admin,
      true,
    );
    expect(saved.map((v) => v.value).sort()).toEqual([36, "Ada"].sort());
    expect(saved.every((v) => v.updatedBy.id === "admin-1")).toBe(true);
    const again = await values.save(
      tenant,
      "u1",
      [set(nick._id, { text: "Grace" }), clear(age._id)],
      { kind: "user", id: "u1" },
      false,
    );
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({
      value: "Grace",
      updatedBy: { kind: "user" },
    });
    expect(await values.count(tenant, age._id)).toBe(0);
    expect(await values.count(tenant, nick._id)).toBe(1);
  });

  test("a bad value writes nothing, even the good ones before it", async () => {
    const a = await make("v_good");
    const b = await make("v_num", "NUMBER");
    const refused = await code(() =>
      values.save(
        tenant,
        "u2",
        [set(a._id, { text: "ok" }), set(b._id, { text: "no" })],
        admin,
        true,
      ),
    );
    expect(refused).toBe("ATTRIBUTE_VALUE_INVALID");
    expect(await values.count(tenant, a._id)).toBe(0);
  });

  test("the attribute must be a live USER one of the tenant, set once", async () => {
    const live = await make("v_live");
    const role = await catalogue.create(tenant, {
      key: "v_role",
      family: "ROLE",
      type: "STRING",
      label,
    });
    const gone = await make("v_gone");
    await catalogue.archive(tenant, gone.id);
    const foreign = await make("v_foreign", "STRING", {}, other);
    const run = (attributeId: string) =>
      code(() =>
        values.save(
          tenant,
          "u3",
          [{ attributeId, value: { text: "x" } }],
          admin,
          true,
        ),
      );
    expect(await run(new ObjectId().toHexString())).toBe("NOT_FOUND");
    expect(await run("nope")).toBe("NOT_FOUND");
    expect(await run(foreign.id)).toBe("NOT_FOUND");
    expect(await run(gone.id)).toBe("ATTRIBUTE_ARCHIVED");
    expect(await run(role.id)).toBe("ATTRIBUTE_FAMILY_MISMATCH");
    expect(
      await code(() =>
        values.save(
          tenant,
          "u3",
          [set(live._id, { text: "a" }), set(live._id, { text: "b" })],
          admin,
          true,
        ),
      ),
    ).toBe("ATTRIBUTE_VALUE_INVALID");
  });

  test("required blocks a console clear, not a self-service one", async () => {
    const must = await make("v_must", "STRING", { required: true });
    await values.save(
      tenant,
      "u4",
      [set(must._id, { text: "x" })],
      admin,
      true,
    );
    expect(
      await code(() =>
        values.save(tenant, "u4", [clear(must._id)], admin, true),
      ),
    ).toBe("ATTRIBUTE_REQUIRED");
    expect(await values.count(tenant, must._id)).toBe(1);
    await values.save(tenant, "u4", [clear(must._id)], admin, false);
    expect(await values.count(tenant, must._id)).toBe(0);
  });

  test("attributesComplete: a user missing a required value is incomplete", async () => {
    const own = new ObjectId();
    try {
      const need = await make("v_need", "STRING", { required: true }, own);
      await values.save(own, "c1", [set(need._id, { text: "x" })], admin, true);
      const incomplete = await values.incomplete(own, ["c1", "c2"]);
      expect([...incomplete]).toEqual(["c2"]);
      expect([...(await values.incomplete(other, ["c2"]))]).toEqual([]);
    } finally {
      await mongo.db.attributeValues.raw.deleteMany({ tenantId: own });
      await mongo.db.userAttributes.raw.deleteMany({ tenantId: own });
    }
  });
});

describe("unique values", () => {
  test("a taken value is refused, normalised, for another user only", async () => {
    const email = await make("v_uniq", "STRING", { unique: true });
    await values.save(
      tenant,
      "n1",
      [set(email._id, { text: "Ada@X.org" })],
      admin,
      true,
    );
    expect(
      await code(() =>
        values.save(
          tenant,
          "n2",
          [set(email._id, { text: " ada@x.ORG " })],
          admin,
          true,
        ),
      ),
    ).toBe("ATTRIBUTE_VALUE_TAKEN");
    // The same user may save the same value again.
    await values.save(
      tenant,
      "n1",
      [set(email._id, { text: "ada@x.org" })],
      admin,
      true,
    );
    // Another tenant has its own namespace.
    const theirs = await make("v_uniq", "STRING", { unique: true }, other);
    await values.save(
      other,
      "n3",
      [set(theirs._id, { text: "ada@x.org" })],
      admin,
      true,
    );
  });

  test("a number is unique by its decimal", async () => {
    const n = await make("v_unum", "NUMBER", { unique: true });
    await values.save(tenant, "m1", [set(n._id, { number: 7 })], admin, true);
    expect(
      await code(() =>
        values.save(tenant, "m2", [set(n._id, { number: 7 })], admin, true),
      ),
    ).toBe("ATTRIBUTE_VALUE_TAKEN");
  });

  test("a taken key found at write time puts the other values back", async () => {
    const a = await make("v_race_a");
    const u = await make("v_race_u", "STRING", { unique: true });
    await values.save(
      tenant,
      "r1",
      [set(a._id, { text: "before" })],
      admin,
      true,
    );
    await values.save(tenant, "r2", [set(u._id, { text: "dup" })], admin, true);
    // Hide the holder from the friendly check so the unique index answers.
    const real = mongo.db.attributeValues.raw;
    const holder = await real.findOne({ tenantId: tenant, userId: "r2" });
    expect(holder).not.toBeNull();
    const spy = new AttributeValuesService({
      values: mongo.db.attributeValues,
      attributes: mongo.db.userAttributes,
    });
    const free = async () => undefined;
    Object.assign(spy, { checkFree: free });
    expect(
      await code(() =>
        spy.save(
          tenant,
          "r1",
          [set(a._id, { text: "after" }), set(u._id, { text: "dup" })],
          admin,
          true,
        ),
      ),
    ).toBe("ATTRIBUTE_VALUE_TAKEN");
    const kept = await values.ofUsers(tenant, ["r1"]);
    expect(kept.get("r1")?.map((v) => v.value)).toEqual(["before"]);
  });

  test("turning unique on writes the keys, over duplicates it is refused and changes nothing", async () => {
    const plain = await make("v_flip", "STRING");
    await values.save(
      tenant,
      "f1",
      [set(plain._id, { text: "same" })],
      admin,
      true,
    );
    await values.save(
      tenant,
      "f2",
      [set(plain._id, { text: "SAME" })],
      admin,
      true,
    );
    const read = defined(await catalogue.find(tenant, plain.id));
    expect(
      await code(() =>
        catalogue.update(tenant, plain.id, read.version, { unique: true }),
      ),
    ).toBe("ATTRIBUTE_NOT_UNIQUE");
    expect((await catalogue.find(tenant, plain.id))?.unique).toBe(false);
    await values.save(
      tenant,
      "f2",
      [set(plain._id, { text: "other" })],
      admin,
      true,
    );
    const ok = await catalogue.update(tenant, plain.id, read.version, {
      unique: true,
    });
    expect(ok.unique).toBe(true);
    const keys = await mongo.db.attributeValues.raw
      .find({ tenantId: tenant, attributeId: plain._id })
      .toArray();
    expect(keys.map((k) => k.uniqueKey).sort()).toEqual(["other", "same"]);
    const off = await catalogue.update(tenant, plain.id, ok.version, {
      unique: false,
    });
    expect(off.unique).toBe(false);
    expect(
      (
        await mongo.db.attributeValues.raw
          .find({ tenantId: tenant, attributeId: plain._id })
          .toArray()
      ).every((k) => k.uniqueKey === null),
    ).toBe(true);
  });
});

describe("the catalogue's questions", () => {
  test("counts, options in use, other types, duplicates", async () => {
    const color = await make("v_pick", "MULTI_SELECT", {
      options: [
        { key: "a", label },
        { key: "b", label },
      ],
    });
    await values.save(
      tenant,
      "q1",
      [set(color._id, { options: ["a", "b"] })],
      admin,
      true,
    );
    const single = await make("v_one", "SELECT", {
      options: [{ key: "x", label }],
    });
    await values.save(
      tenant,
      "q1",
      [set(single._id, { options: ["x"] })],
      admin,
      true,
    );
    expect(await values.countOptions(tenant, color._id, ["b"])).toBe(1);
    expect(await values.countOptions(tenant, color._id, ["zz"])).toBe(0);
    expect(await values.countOptions(tenant, single._id, ["x"])).toBe(1);
    expect(await values.countOtherType(tenant, color._id, "STRING")).toBe(1);
    expect(await values.countOtherType(tenant, color._id, "MULTI_SELECT")).toBe(
      0,
    );
    const counts = await values.counts(tenant, [
      color._id,
      single._id,
      new ObjectId(),
    ]);
    expect(counts.get(color._id.toHexString())).toBe(1);
    expect(counts.get(single._id.toHexString())).toBe(1);
    expect(await values.counts(tenant, [])).toEqual(new Map());
    expect(await values.countDuplicates(tenant, color._id)).toBe(0);
  });

  test("a value written under another type is ignored by the export's visibility", async () => {
    const t = await make("v_typed", "STRING");
    await values.save(tenant, "t1", [set(t._id, { text: "x" })], admin, true);
    await mongo.db.attributeValues.raw.updateMany(
      { tenantId: tenant, attributeId: t._id },
      { $set: { type: "NUMBER" } },
    );
    const exported = await values.personalDataOf(tenant, "t1");
    expect(exported.find((e) => e.key === "v_typed")?.hidden).toBe(true);
  });
});

describe("erase and export", () => {
  test("the export lists every value with its key and label, hidden ones flagged", async () => {
    const live = await make("v_ex_live");
    const old = await make("v_ex_old");
    await values.save(
      tenant,
      "e1",
      [set(live._id, { text: "hello" }), set(old._id, { text: "bye" })],
      admin,
      true,
    );
    await catalogue.archive(tenant, old.id);
    const exported = await values.personalDataOf(tenant, "e1");
    const byKey = new Map(exported.map((e) => [e.key, e]));
    expect(byKey.get("v_ex_live")).toMatchObject({
      value: "hello",
      hidden: false,
      roles: [],
      label,
    });
    expect(byKey.get("v_ex_old")).toMatchObject({ value: "bye", hidden: true });
    expect(defined(byKey.get("v_ex_live")).updatedAt).toBeInstanceOf(Date);
    expect(await values.personalDataOf(other, "e1")).toEqual([]);
  });

  test("removeUser leaves no value of the user, only theirs, in their tenant", async () => {
    const a = await make("v_rm");
    await values.save(tenant, "x1", [set(a._id, { text: "one" })], admin, true);
    await values.save(tenant, "x2", [set(a._id, { text: "two" })], admin, true);
    expect(await values.removeUser(other, "x1")).toBe(0);
    expect(await values.removeUser(tenant, "x1")).toBe(1);
    expect(await values.personalDataOf(tenant, "x1")).toEqual([]);
    expect(await values.personalDataOf(tenant, "x2")).toHaveLength(1);
    expect(await values.removeUser(tenant, "x1")).toBe(0);
  });

  test("deleting an attribute removes its values", async () => {
    const a = await make("v_del");
    await values.save(tenant, "d1", [set(a._id, { text: "x" })], admin, true);
    await catalogue.archive(tenant, a.id);
    await catalogue.delete(tenant, a.id, "v_del");
    expect(await values.count(tenant, a._id)).toBe(0);
  });
});
