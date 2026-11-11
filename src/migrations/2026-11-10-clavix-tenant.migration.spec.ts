import { beforeEach, describe, expect, test } from "bun:test";
import { getCollection } from "@softistx/mongo";
import { migrate, rollback } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { tenants } from "@/modules/collections";
import { freshMigrationDb } from "~/migrations";
import { clavixTenant, id } from "./2026-11-10-clavix-tenant.migration";

let db: Db;
beforeEach(async () => {
  db = await freshMigrationDb();
});

const platform = () =>
  getCollection(db, tenants).findMany({ filter: { slug: "clavix" } });

describe(id, () => {
  test("up seeds the clavix tenant, active, with its stamps", async () => {
    await migrate(db, [clavixTenant]);
    const found = await platform();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      slug: "clavix",
      name: "Clavix",
      status: "active",
    });
  });

  test("a second run leaves one tenant with the same _id", async () => {
    await migrate(db, [clavixTenant]);
    const [first] = await platform();
    // Forget the record so the migration runs again on the same data.
    await db.collection("nxgt_migrations").deleteMany({});
    await migrate(db, [clavixTenant]);
    const found = await platform();
    expect(found).toHaveLength(1);
    expect(found[0]?._id).toEqual(first?._id);
  });

  test("down removes it", async () => {
    await migrate(db, [clavixTenant]);
    await rollback(db, [clavixTenant], {});
    expect(await platform()).toHaveLength(0);
  });
});
