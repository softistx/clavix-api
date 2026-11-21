import { beforeEach, describe, expect, test } from "bun:test";
import { migrate, rollback } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import type { PublicOrigin } from "@/modules/tenants";
import { freshMigrationDb } from "~/migrations";
import { clavixTenant } from "./2026-11-10-clavix-tenant.migration";
import { consoleSeed, id } from "./2026-11-12-console.migration";

const origin: PublicOrigin = { scheme: "https", domain: "clavix.test" };

let db: Db;
beforeEach(async () => {
  db = await freshMigrationDb();
});

describe(id, () => {
  test("announces the secret of the client it creates, once, and nothing when it re-seeds", async () => {
    const secrets: string[] = [];
    const migration = consoleSeed({
      origin,
      announce: (secret) => secrets.push(secret),
    });
    await migrate(db, [clavixTenant, migration]);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.length).toBeGreaterThan(20);

    await rollback(db, [clavixTenant, migration]);
    await migrate(db, [clavixTenant, migration]);
    expect(secrets).toHaveLength(2);
    expect(secrets[1]).not.toBe(secrets[0]);
  });
});
