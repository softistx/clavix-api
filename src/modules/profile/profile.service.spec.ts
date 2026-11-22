import { afterAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { extensionCodeOf } from "@/shared/errors";
import { ProfilePoliciesService } from "./profile.service";

// Tenant ids of their own: the service reads and writes through the scope, so
// no tenant document is needed and no other spec's data is touched.
const tenant = new ObjectId();
const other = new ObjectId();
const service = new ProfilePoliciesService({
  policies: mongo.db.profilePolicies,
});

const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return String(extensionCodeOf(error));
  }
  return undefined;
};

afterAll(async () => {
  await mongo.db.profilePolicies.raw.deleteMany({
    tenantId: { $in: [tenant, other] },
  });
});

describe("ProfilePoliciesService", () => {
  test("nothing is locked, at version 0, while nothing is stored", async () => {
    expect(await service.get(tenant)).toEqual({
      tenantId: tenant,
      locked: [],
      version: 0,
      updatedAt: null,
    });
    expect(await service.lockedFor(tenant)).toEqual([]);
  });

  test("the first write needs version 0, stores the fields once and in order", async () => {
    const written = await service.set(tenant, ["PHONE", "NAME", "PHONE"], 0);
    expect(written.locked).toEqual(["NAME", "PHONE"]);
    expect(written.updatedAt).toBeInstanceOf(Date);
    expect(await service.lockedFor(tenant)).toEqual(["NAME", "PHONE"]);
    expect(
      await mongo.db.profilePolicies.raw.countDocuments({ tenantId: tenant }),
    ).toBe(1);
  });

  test("a write at a stale version is CONFLICT and changes nothing", async () => {
    const read = await service.get(tenant);
    await service.set(tenant, ["ADDRESS"], read.version);
    expect(
      await code(() => service.set(tenant, ["NICKNAME"], read.version)),
    ).toBe("CONFLICT");
    expect(await service.lockedFor(tenant)).toEqual(["ADDRESS"]);
    // A first write over a stored document (version 0 again) is stale too.
    expect(await code(() => service.set(tenant, [], 0))).toBe("CONFLICT");
  });

  test("each change raises the version; the same list stores nothing", async () => {
    const before = await service.get(tenant);
    const same = await service.set(tenant, ["ADDRESS"], before.version);
    expect(same.version).toBe(before.version);
    expect(same.updatedAt).toEqual(before.updatedAt);
    const changed = await service.set(tenant, [], before.version);
    expect(changed.version).toBeGreaterThan(before.version);
    expect(changed.locked).toEqual([]);
  });

  test("two first writes racing: one wins, the other is CONFLICT", async () => {
    const racing = new ObjectId();
    try {
      const results = await Promise.all([
        code(() => service.set(racing, ["PHONE"], 0)),
        code(() => service.set(racing, ["LOCALE"], 0)),
      ]);
      expect(results.filter((r) => r === undefined)).toHaveLength(1);
      expect(results.filter((r) => r === "CONFLICT")).toHaveLength(1);
      expect(
        await mongo.db.profilePolicies.raw.countDocuments({ tenantId: racing }),
      ).toBe(1);
    } finally {
      await mongo.db.profilePolicies.raw.deleteMany({ tenantId: racing });
    }
  });

  test("two writes at the same version: one wins, the other is CONFLICT", async () => {
    const racing = new ObjectId();
    try {
      await service.set(racing, ["NAME"], 0);
      const { version } = await service.get(racing);
      const results = await Promise.all([
        code(() => service.set(racing, ["PHONE"], version)),
        code(() => service.set(racing, ["LOCALE"], version)),
      ]);
      expect(results.filter((r) => r === undefined)).toHaveLength(1);
      expect(results.filter((r) => r === "CONFLICT")).toHaveLength(1);
    } finally {
      await mongo.db.profilePolicies.raw.deleteMany({ tenantId: racing });
    }
  });

  test("a tenant never sees or changes another's locks", async () => {
    await service.set(other, ["BIRTHDATE"], 0);
    expect(await service.lockedFor(other)).toEqual(["BIRTHDATE"]);
    expect(await service.lockedFor(tenant)).toEqual([]);
    expect(await service.get(new ObjectId())).toMatchObject({
      locked: [],
      version: 0,
    });
  });
});
