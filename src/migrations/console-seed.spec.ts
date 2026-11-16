import { beforeEach, describe, expect, test } from "bun:test";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { getCollection } from "@softistx/mongo";
import { migrate } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { CONSOLE_CLIENT_ID } from "@/console/identity";
import { tenants } from "@/modules/collections";
import { type PublicOrigin, partitionOf } from "@/modules/tenants/identity";
import { freshMigrationDb } from "~/migrations";
import { clavixTenant } from "./2026-11-10-clavix-tenant.migration";
import { seedConsole, unseedConsole } from "./console-seed";

const origin: PublicOrigin = { scheme: "https", domain: "clavix.test" };

let db: Db;
beforeEach(async () => {
  db = await freshMigrationDb();
  await migrate(db, [clavixTenant]);
});

describe("unseedConsole", () => {
  test("revokes the console client's access and refresh tokens, and removes the client", async () => {
    await seedConsole(db, origin);
    const tenant = await getCollection(db, tenants).findFirst({
      slug: "clavix",
    });
    if (tenant === undefined) throw new Error("no clavix tenant");
    const store = createMongoOAuth(db, { partition: partitionOf(tenant._id) });
    const now = new Date();
    const later = new Date(now.getTime() + 3_600_000);
    const grantId = "grant-1" as never;
    const common = {
      grantId,
      userId: "user-1" as never,
      clientId: CONSOLE_CLIENT_ID as never,
      resource: "https://console.clavix.test/api",
      scopes: ["console"],
      createdAt: now,
      expiresAt: later,
      revokedAt: null,
    };
    await store.upsertGrant({
      id: grantId,
      userId: common.userId,
      clientId: common.clientId,
      resource: common.resource,
      scopes: common.scopes,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    });
    await store.insertAccessToken({ ...common, tokenHash: "access-hash" });
    await store.insertRefreshToken({
      ...common,
      tokenHash: "refresh-hash",
      absoluteExpiresAt: later,
      rotatedAt: null,
    });
    expect((await store.findAccessToken("access-hash"))?.revokedAt).toBeNull();

    await unseedConsole(db, origin);

    expect(
      (await store.findAccessToken("access-hash"))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      (await store.findRefreshToken("refresh-hash"))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(await store.findClient(CONSOLE_CLIENT_ID as never)).toBeNull();
  });
});
