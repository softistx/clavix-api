import { afterAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  attributesService as catalogue,
  userFilterService as filters,
  roleAttributesService as links,
  attributeValuesService as values,
} from "@/config/attributes";
import { mongo } from "@/config/db";
import { rolesService } from "@/config/roles";
import { extensionCodeOf } from "@/shared/errors";
import { MAX_FILTERS } from "../utils";

const tenant = new ObjectId();
const admin = { kind: "admin", id: "admin-1" } as const;
const label = [{ locale: "en", text: "Label" }];
const options = ["a", "b"].map((key) => ({ key, label }));
const all = { ids: null, after: null, limit: 10 };

const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return String(extensionCodeOf(error));
  }
  return undefined;
};

afterAll(async () => {
  await mongo.db.roleAttributes.raw.deleteMany({ tenantId: tenant });
  await mongo.db.attributeValues.raw.deleteMany({ tenantId: tenant });
  await mongo.db.userAttributes.raw.deleteMany({ tenantId: tenant });
  await mongo.db.roleAssignments.raw.deleteMany({ tenantId: tenant });
  await mongo.db.roles.raw.deleteMany({ tenantId: tenant });
});

describe("page", () => {
  test("combines a role, a choice and a role attribute, with a stable cursor", async () => {
    const colour = await catalogue.create(tenant, {
      key: "uf_colour",
      family: "USER",
      type: "SELECT",
      label,
      options,
    });
    const vip = await catalogue.create(tenant, {
      key: "uf_vip",
      family: "ROLE",
      type: "BOOLEAN",
      label,
    });
    const role = await rolesService.create(tenant, { name: "uf-doctor" });
    await links.assign(tenant, role.id, vip._id.toHexString(), false);
    const colourId = colour._id.toHexString();
    const vipId = vip._id.toHexString();
    for (const user of ["u1", "u2", "u3"]) {
      await values.save(
        tenant,
        user,
        [{ attributeId: colourId, value: { options: ["a"] } }],
        admin,
        false,
      );
    }
    await values.save(
      tenant,
      "u4",
      [{ attributeId: colourId, value: { options: ["b"] } }],
      admin,
      false,
    );
    for (const user of ["u1", "u2", "u4"])
      await rolesService.assign(tenant, role.id, user);
    for (const user of ["u1", "u4"]) {
      await values.save(
        tenant,
        user,
        [{ attributeId: vipId, value: { boolean: true } }],
        admin,
        false,
        {
          family: "ROLE",
          links: await links.linksHeld(tenant, user, role.id),
        },
      );
    }
    const colourA = { attributeId: colourId, options: ["a"] };
    const holders = await filters.page(tenant, { roleId: role.id }, all);
    expect(holders.userIds).toEqual(["u1", "u2", "u4"]);
    expect(holders.totalCount).toBe(3);
    const both = await filters.page(
      tenant,
      { roleId: role.id, attributes: [colourA] },
      all,
    );
    expect(both.userIds).toEqual(["u1", "u2"]);
    const vips = await filters.page(
      tenant,
      { attributes: [{ attributeId: vipId, boolean: true }] },
      all,
    );
    expect(vips.userIds).toEqual(["u1", "u4"]);
    const first = await filters.page(
      tenant,
      { attributes: [colourA] },
      { ids: null, after: null, limit: 2 },
    );
    expect(first.userIds).toEqual(["u1", "u2"]);
    expect(first.totalCount).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    const again = await filters.page(
      tenant,
      { attributes: [colourA] },
      { ids: null, after: "u2", limit: 2 },
    );
    expect(again).toMatchObject({
      userIds: ["u3"],
      nextCursor: null,
      totalCount: 3,
    });
    const narrowed = await filters.page(
      tenant,
      { attributes: [colourA] },
      { ids: ["u2", "u4"], after: null, limit: 5 },
    );
    expect(narrowed.userIds).toEqual(["u2"]);
  });

  test("a role value shows only while a linked role is held", async () => {
    const flag = await catalogue.create(tenant, {
      key: "uf_flag",
      family: "ROLE",
      type: "BOOLEAN",
      label,
    });
    const role = await rolesService.create(tenant, { name: "uf-nurse" });
    await links.assign(tenant, role.id, flag._id.toHexString(), false);
    await rolesService.assign(tenant, role.id, "u9");
    await values.save(
      tenant,
      "u9",
      [{ attributeId: flag._id.toHexString(), value: { boolean: true } }],
      admin,
      false,
      {
        family: "ROLE",
        links: await links.linksHeld(tenant, "u9", role.id),
      },
    );
    const filter = {
      attributes: [{ attributeId: flag._id.toHexString(), boolean: true }],
    };
    expect((await filters.page(tenant, filter, all)).userIds).toEqual(["u9"]);
    await mongo.db.roleAssignments.raw.deleteMany({
      tenantId: tenant,
      userId: "u9",
    });
    expect((await filters.page(tenant, filter, all)).userIds).toEqual([]);
  });

  test("another tenant's values never match", async () => {
    const stranger = await filters.page(
      new ObjectId(),
      { roleId: new ObjectId().toHexString() },
      all,
    );
    expect(stranger).toEqual({ userIds: [], nextCursor: null, totalCount: 0 });
  });
});

describe("refusals", () => {
  const bad = (filter: Parameters<typeof filters.page>[1]) =>
    code(() => filters.page(tenant, filter, all));

  test("more than five filters, an unknown, archived or unfit attribute, a bad option", async () => {
    const text = await catalogue.create(tenant, {
      key: "uf_text",
      family: "USER",
      type: "STRING",
      label,
    });
    const old = await catalogue.create(tenant, {
      key: "uf_old",
      family: "USER",
      type: "SELECT",
      label,
      options,
    });
    await catalogue.archive(tenant, old._id.toHexString());
    const one = { attributeId: text._id.toHexString(), options: ["a"] };
    expect(
      await bad({
        attributes: Array.from({ length: MAX_FILTERS + 1 }, () => one),
      }),
    ).toBe("BAD_USER_INPUT");
    expect(
      await bad({
        attributes: [
          { attributeId: new ObjectId().toHexString(), options: ["a"] },
        ],
      }),
    ).toBe("BAD_USER_INPUT");
    expect(
      await bad({ attributes: [{ attributeId: "nope", options: ["a"] }] }),
    ).toBe("BAD_USER_INPUT");
    expect(await bad({ attributes: [one] })).toBe("BAD_USER_INPUT");
    expect(
      await bad({
        attributes: [{ attributeId: old._id.toHexString(), options: ["a"] }],
      }),
    ).toBe("BAD_USER_INPUT");
    expect(await bad({ roleId: "nope" })).toBe("BAD_USER_INPUT");
    expect(await bad({})).toBe("BAD_USER_INPUT");
  });
});
