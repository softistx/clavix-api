import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { freshMigrationDb } from "~/migrations";
import {
  clientGrantsMigration,
  id,
  migrateClientGrants,
} from "./2026-11-15-client-grants.migration";

const DEVICE = "urn:ietf:params:oauth:grant-type:device_code";
let db: Db;

const put = (collection: string, name: string, grantTypes?: string[]) =>
  db.collection(collection).insertOne({
    _id: name as never,
    name,
    redirectUris: ["https://app.example/cb"],
    source: "registered",
    createdAt: new Date(),
    expiresAt: null,
    ...(collection === "oauthPartitionedClients" ? { partition: "p" } : {}),
    ...(grantTypes === undefined ? {} : { grantTypes }),
  });
const grantsOf = async (collection: string, name: string) =>
  (await db.collection(collection).findOne({ _id: name as never }))?.[
    "grantTypes"
  ];

beforeEach(async () => {
  db = await freshMigrationDb();
});

describe(id, () => {
  test("repairs lists with no usable grant, then adds refresh_token, on both collections", async () => {
    for (const collection of ["oauthClients", "oauthPartitionedClients"]) {
      await put(collection, "empty", []);
      await put(collection, "refresh-only", ["refresh_token"]);
      await put(collection, "code-only", ["authorization_code"]);
      await put(collection, "device-only", [DEVICE]);
      await put(collection, "full", ["authorization_code", "refresh_token"]);
      await put(collection, "default");
    }
    await migrate(db, [clientGrantsMigration]);
    for (const collection of ["oauthClients", "oauthPartitionedClients"]) {
      expect(await grantsOf(collection, "empty")).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      expect(await grantsOf(collection, "refresh-only")).toEqual([
        "refresh_token",
        "authorization_code",
      ]);
      expect(await grantsOf(collection, "code-only")).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      expect(await grantsOf(collection, "device-only")).toEqual([
        DEVICE,
        "refresh_token",
      ]);
      expect(await grantsOf(collection, "full")).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      // A client with no list keeps the default: no list.
      expect(await grantsOf(collection, "default")).toBeUndefined();
    }
  });

  test("a second run changes nothing", async () => {
    await put("oauthClients", "c", ["authorization_code"]);
    expect(await migrateClientGrants(db)).toEqual({
      unusable: 0,
      withoutRefresh: 1,
    });
    expect(await migrateClientGrants(db)).toEqual({
      unusable: 0,
      withoutRefresh: 0,
    });
  });
});
