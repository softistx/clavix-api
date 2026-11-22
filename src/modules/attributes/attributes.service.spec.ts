import { afterAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { extensionCodeOf } from "@/shared/errors";
import { defined } from "~/narrow";
import type { AttributeType } from "./attributes.model";
import { AttributesService } from "./attributes.service";
import type { AttributeValues } from "./attributes.types";

// A tenant id of its own: the service reads and writes through the scope, so
// no tenant document is needed and no other spec's data is touched.
const tenant = new ObjectId();
const other = new ObjectId();

/** What the stored values answer: set per test, as slice A2's store will. */
const held = {
  count: 0,
  otherType: 0,
  options: 0,
  duplicates: 0,
  removed: [] as string[],
  during: async () => {},
};
const values: AttributeValues = {
  count: async () => held.count,
  counts: async (_, ids) =>
    new Map(ids.map((id) => [id.toHexString(), held.count])),
  countOtherType: async () => {
    await held.during();
    return held.otherType;
  },
  countOptions: async () => held.options,
  countDuplicates: async () => held.duplicates,
  removeAll: async (_, id) => {
    held.removed.push(id.toHexString());
  },
};
const service = new AttributesService({
  attributes: mongo.db.userAttributes,
  scopes: mongo.db.scopes,
  values,
});

const reset = () => {
  held.count = 0;
  held.otherType = 0;
  held.options = 0;
  held.duplicates = 0;
  held.removed = [];
  held.during = async () => {};
};

const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return String(extensionCodeOf(error));
  }
  return undefined;
};

const label = [{ locale: "en", text: "Label" }];
const make = (key: string, extra: Record<string, unknown> = {}) =>
  service.create(tenant, {
    key,
    family: "USER",
    type: "STRING",
    label,
    ...extra,
  });

afterAll(async () => {
  for (const tenantId of [tenant, other]) {
    await mongo.db.userAttributes.raw.deleteMany({ tenantId });
    await mongo.db.scopes.raw.deleteMany({ tenantId });
  }
});

describe("attributes catalogue", () => {
  test("create stores the defaults and lists by position", async () => {
    reset();
    const a = await make("svc_a");
    const b = await make("svc_b", {
      description: [{ locale: "en", text: " About " }],
      unit: " kg ",
      type: "NUMBER",
    });
    expect(a).toMatchObject({
      key: "svc_a",
      family: "USER",
      required: false,
      userEditable: false,
      unique: false,
      emission: null,
      unit: null,
      archivedAt: null,
    });
    expect(b.description).toEqual([{ locale: "en", text: "About" }]);
    expect(b.unit).toBe("kg");
    expect(b.position).toBeGreaterThan(a.position);
    const listed = await service.list(tenant, { archived: false });
    expect(listed.map((x) => x.key)).toEqual(["svc_a", "svc_b"]);
    expect(await service.list(other, { archived: false })).toEqual([]);
    expect(
      await service.list(tenant, { family: "ROLE", archived: false }),
    ).toEqual([]);
  });

  test("a bad, a reserved and a taken key are refused", async () => {
    expect(await code(() => make("Bad Key"))).toBe("ATTRIBUTE_KEY_INVALID");
    expect(await code(() => make("a"))).toBe("ATTRIBUTE_KEY_INVALID");
    expect(await code(() => make("email"))).toBe("ATTRIBUTE_KEY_RESERVED");
    expect(await code(() => make("roles"))).toBe("ATTRIBUTE_KEY_RESERVED");
    expect(await code(() => make("svc_a"))).toBe("ATTRIBUTE_KEY_TAKEN");
    // Another tenant may use the key.
    expect(
      (
        await service.create(other, {
          key: "svc_a",
          family: "USER",
          type: "STRING",
          label,
        })
      ).key,
    ).toBe("svc_a");
  });

  test("a label needs a language; options belong to choices", async () => {
    expect(await code(() => make("svc_nolabel", { label: [] }))).toBe(
      "BAD_USER_INPUT",
    );
    expect(
      await code(() => make("svc_opts", { options: [{ key: "x", label }] })),
    ).toBe("BAD_USER_INPUT");
    const select = await make("svc_select", {
      type: "SELECT",
      options: [
        { key: "red", label },
        { key: "blue", label },
      ],
    });
    expect(select.options.map((o) => o.key)).toEqual(["red", "blue"]);
    expect(
      await code(() =>
        make("svc_dup", {
          type: "SELECT",
          options: [
            { key: "red", label },
            { key: "red", label },
          ],
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      await code(() =>
        make("svc_badopt", {
          type: "SELECT",
          options: [{ key: "Red!", label }],
        }),
      ),
    ).toBe("BAD_USER_INPUT");
  });

  test("unique only holds for text and number; a role attribute is not required itself", async () => {
    expect(
      await code(() => make("svc_u1", { type: "BOOLEAN", unique: true })),
    ).toBe("ATTRIBUTE_UNIQUE_UNSUPPORTED");
    expect((await make("svc_u2", { unique: true })).unique).toBe(true);
    expect(
      await code(() =>
        service.create(tenant, {
          key: "svc_r1",
          family: "ROLE",
          type: "STRING",
          label,
          required: true,
        }),
      ),
    ).toBe("BAD_USER_INPUT");
  });

  test("an emitted attribute is never editable, and its scope must exist", async () => {
    expect(
      await code(() =>
        make("svc_e1", { emissionScope: "openid", userEditable: true }),
      ),
    ).toBe("ATTRIBUTE_EDITABLE_EMITTED");
    expect(await code(() => make("svc_e2", { emissionScope: "nope" }))).toBe(
      "ATTRIBUTE_SCOPE_UNKNOWN",
    );
    // A standard scope counts without a document.
    expect(
      (await make("svc_e3", { emissionScope: "profile" })).emission,
    ).toEqual({
      scope: "profile",
    });
    await mongo.db.scopes.create({
      tenantId: tenant,
      name: "svc:read",
      description: [],
    });
    expect(
      (await make("svc_e4", { emissionScope: "svc:read" })).emission,
    ).toEqual({
      scope: "svc:read",
    });
  });

  test("update checks the version, merges, and writes nothing when nothing changes", async () => {
    reset();
    const created = await make("svc_up");
    const id = created._id.toHexString();
    const same = await service.update(tenant, id, created.version, {
      label,
      required: false,
    });
    expect(same.version).toBe(created.version);
    const changed = await service.update(tenant, id, created.version, {
      label: [{ locale: "fr", text: "Libelle" }],
      required: true,
      unit: "m",
    });
    expect(changed.label.map((t) => t.locale).sort()).toEqual(["en", "fr"]);
    expect(changed).toMatchObject({ required: true, unit: "m" });
    expect(changed.version).toBeGreaterThan(created.version);
    expect(
      await code(() =>
        service.update(tenant, id, created.version, { required: false }),
      ),
    ).toBe("CONFLICT");
    expect(
      await code(() => service.update(other, id, changed.version, {})),
    ).toBe("NOT_FOUND");
    expect(
      await code(() => service.update(tenant, "nope", changed.version, {})),
    ).toBe("NOT_FOUND");
    const cleared = await service.update(tenant, id, changed.version, {
      unit: null,
    });
    expect(cleared.unit).toBeNull();
  });

  test("the type is locked by values, the options by values, unique by duplicates", async () => {
    reset();
    const created = await make("svc_lock", {
      type: "SELECT",
      options: [
        { key: "a", label },
        { key: "b", label },
      ],
    });
    const id = created._id.toHexString();
    held.count = 2;
    expect(
      await code(() =>
        service.update(tenant, id, created.version, { type: "MULTI_SELECT" }),
      ),
    ).toBe("ATTRIBUTE_TYPE_LOCKED");
    held.count = 0;
    held.options = 1;
    expect(
      await code(() =>
        service.update(tenant, id, created.version, {
          options: [{ key: "a", label }],
        }),
      ),
    ).toBe("ATTRIBUTE_OPTION_IN_USE");
    held.options = 0;
    const narrowed = await service.update(tenant, id, created.version, {
      options: [{ key: "a", label }],
    });
    expect(narrowed.options).toHaveLength(1);
    const text = await make("svc_dups");
    held.duplicates = 1;
    expect(
      await code(() =>
        service.update(tenant, text._id.toHexString(), text.version, {
          unique: true,
        }),
      ),
    ).toBe("ATTRIBUTE_NOT_UNIQUE");
    held.duplicates = 0;
    const retyped = await service.update(
      tenant,
      text._id.toHexString(),
      text.version,
      {
        type: "TEXT" satisfies AttributeType,
      },
    );
    expect(retyped.type).toBe("TEXT");
  });

  test("a value written under the old type during the change puts the type back", async () => {
    reset();
    const created = await make("svc_race");
    held.otherType = 1;
    expect(
      await code(() =>
        service.update(tenant, created._id.toHexString(), created.version, {
          type: "TEXT",
        }),
      ),
    ).toBe("ATTRIBUTE_TYPE_LOCKED");
    held.otherType = 0;
    const found = defined(
      await service.find(tenant, created._id.toHexString()),
    );
    expect(found.type).toBe("STRING");
  });

  test("a concurrent edit during the type put-back answers CONFLICT, not a raw error", async () => {
    reset();
    const created = await make("svc_race_lock");
    const id = created._id;
    held.otherType = 1;
    held.during = async () => {
      // Another edit lands after the write and before the put-back.
      await mongo.db.userAttributes.updateOne(
        { _id: id },
        { $inc: { version: 1 } },
      );
    };
    expect(
      await code(() =>
        service.update(tenant, id.toHexString(), created.version, {
          type: "TEXT",
        }),
      ),
    ).toBe("CONFLICT");
  });

  test("move writes one document, renumbers when the gap is gone, and refuses an archived one", async () => {
    reset();
    const first = await make("svc_m1");
    const second = await make("svc_m2");
    const third = await make("svc_m3");
    const order = async () =>
      (await service.list(tenant, { family: "USER", archived: false }))
        .filter((a) => a.key.startsWith("svc_m"))
        .map((a) => a.key);
    expect(await order()).toEqual(["svc_m1", "svc_m2", "svc_m3"]);
    await service.move(tenant, third._id.toHexString(), 0);
    const live = await service.list(tenant, {
      family: "USER",
      archived: false,
    });
    const index = live.findIndex((a) => a.key === "svc_m3");
    expect(index).toBe(0);
    // Dragging again and again to the same slot halves the gap until a renumber.
    for (let i = 0; i < 60; i += 1) {
      await service.move(tenant, second._id.toHexString(), 1);
      await service.move(tenant, first._id.toHexString(), 1);
    }
    const after = await service.list(tenant, {
      family: "USER",
      archived: false,
    });
    const positions = after.map((a) => a.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    await service.archive(tenant, first._id.toHexString());
    expect(
      await code(() => service.move(tenant, first._id.toHexString(), 0)),
    ).toBe("ATTRIBUTE_ARCHIVED");
  });

  test("archive and restore are idempotent; an archived one holds its key and cannot change", async () => {
    const created = await make("svc_arch");
    const id = created._id.toHexString();
    const archived = await service.archive(tenant, id);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect((await service.archive(tenant, id)).version).toBe(archived.version);
    expect(
      (await service.list(tenant, { archived: true })).map((a) => a.key),
    ).toContain("svc_arch");
    expect(
      (await service.list(tenant, { archived: false })).map((a) => a.key),
    ).not.toContain("svc_arch");
    expect(await code(() => make("svc_arch"))).toBe("ATTRIBUTE_KEY_TAKEN");
    expect(
      await code(() =>
        service.update(tenant, id, archived.version, { required: true }),
      ),
    ).toBe("ATTRIBUTE_ARCHIVED");
    const restored = await service.restore(tenant, id);
    expect(restored.archivedAt).toBeNull();
    expect((await service.restore(tenant, id)).version).toBe(restored.version);
  });

  test("delete needs an archived attribute and its key, removes its values and frees the key; a repeat is true", async () => {
    reset();
    const created = await make("svc_del");
    const id = created._id.toHexString();
    expect(await code(() => service.delete(tenant, id, "svc_del"))).toBe(
      "ATTRIBUTE_NOT_ARCHIVED",
    );
    await service.archive(tenant, id);
    expect(await code(() => service.delete(tenant, id, "wrong"))).toBe(
      "ATTRIBUTE_DELETE_UNCONFIRMED",
    );
    expect(await service.delete(tenant, id, "svc_del")).toBe(true);
    expect(held.removed).toEqual([id]);
    expect(await service.find(tenant, id)).toBeUndefined();
    expect(await service.delete(tenant, id, "svc_del")).toBe(true);
    expect((await make("svc_del")).key).toBe("svc_del");
  });

  test("tenants do not see each other's attributes", async () => {
    const mine = await make("svc_iso");
    const id = mine._id.toHexString();
    expect(await service.find(other, id)).toBeUndefined();
    expect(await code(() => service.archive(other, id))).toBe("NOT_FOUND");
    expect(await service.delete(other, id, "svc_iso")).toBe(true);
    expect(await service.find(tenant, id)).toBeDefined();
  });

  test("a tenant holds at most 100 attributes", async () => {
    const full = new ObjectId();
    try {
      for (let i = 0; i < 100; i += 1) {
        await service.create(full, {
          key: `lim_${i}`,
          family: "USER",
          type: "STRING",
          label,
        });
      }
      expect(
        await code(() =>
          service.create(full, {
            key: "lim_over",
            family: "USER",
            type: "STRING",
            label,
          }),
        ),
      ).toBe("ATTRIBUTE_LIMIT");
      expect(
        await mongo.db.userAttributes.raw.countDocuments({ tenantId: full }),
      ).toBe(100);
    } finally {
      await mongo.db.userAttributes.raw.deleteMany({ tenantId: full });
    }
  });
});
