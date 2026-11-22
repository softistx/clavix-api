import { afterAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { attributesService, attributeValuesService } from "@/config/attributes";
import { mongo } from "@/config/db";
import { createExclusive } from "@/console/exclusive";
import { withMembers } from "~/members";
import { completeLoader, sectionsLoader } from "./attributes.data-loader";

// A tenant id of its own: the services read through the tenant scope.
const tenant = new ObjectId();
const request = () => withMembers({ exclusive: createExclusive(null) });
const label = [{ locale: "en", text: "Label" }];

afterAll(async () => {
  await mongo.db.userAttributes.raw.deleteMany({ tenantId: tenant });
  await mongo.db.attributeValues.raw.deleteMany({ tenantId: tenant });
});

describe("attribute loaders", () => {
  test("sections: the general attributes by position with each user's value, and the value counts", async () => {
    const first = await attributesService.create(tenant, {
      key: "dl_first",
      family: "USER",
      type: "STRING",
      label,
      required: true,
    });
    const second = await attributesService.create(tenant, {
      key: "dl_second",
      family: "USER",
      type: "NUMBER",
      label,
    });
    await attributeValuesService.save(
      tenant,
      "dl-u1",
      [
        { attributeId: first._id.toHexString(), value: { text: "One" } },
        { attributeId: second._id.toHexString(), value: { number: 2 } },
      ],
      { kind: "admin", id: "dl-admin" },
      false,
    );
    const loader = sectionsLoader(request(), tenant.toHexString());
    const [one, none] = await Promise.all([
      loader.load("dl-u1"),
      loader.load("dl-u2"),
    ]);
    expect(
      one?.general.map((v) => [v.attribute.key, v.text, v.number]),
    ).toEqual([
      ["dl_first", "One", null],
      ["dl_second", null, 2],
    ]);
    expect(one?.general[0]?.attribute.valueCount).toBe(1);
    expect(none?.general.map((v) => [v.text, v.number])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(one?.roles).toEqual([]);
  });

  test("complete: false only for a user missing a required value; one batch per request", async () => {
    const ctx = request();
    const loader = completeLoader(ctx, tenant.toHexString());
    expect(
      await Promise.all([loader.load("dl-u1"), loader.load("dl-u2")]),
    ).toEqual([true, false]);
    expect(completeLoader(ctx, tenant.toHexString())).toBe(loader);
  });
});
