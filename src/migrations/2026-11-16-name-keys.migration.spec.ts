import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { freshMigrationDb } from "~/migrations";
import {
  backfillNameKeys,
  id,
  nameKeyOf,
  nameKeysMigration,
} from "./2026-11-16-name-keys.migration";

let db: Db;
const put = (key: string, fields: Record<string, unknown>, extra = {}) =>
  db.collection("partitionedUsers").insertOne({
    _id: key as never,
    partition: "p",
    type: "user",
    fields,
    logins: [],
    version: 1,
    ...extra,
  });
const keyOf = async (key: string) =>
  (await db.collection("partitionedUsers").findOne({ _id: key as never }))?.[
    "nameKey"
  ];

beforeEach(async () => {
  db = await freshMigrationDb();
});

describe(id, () => {
  test("folds names like the core", () => {
    expect(nameKeyOf("  Ada   LOVELACE ")).toBe("ada lovelace");
    expect(nameKeyOf("ＡＢＣ")).toBe("abc");
  });

  test("keys users without a key, leaves the rest, and is idempotent", async () => {
    await put("a", { name: "Ada  Lovelace" });
    await put("b", { name: "Kept" }, { nameKey: "custom" });
    await put("c", { email: "c@x.test" });
    await put("d", { name: "   " });
    await migrate(db, [nameKeysMigration]);
    expect(await keyOf("a")).toBe("ada lovelace");
    expect(await keyOf("b")).toBe("custom");
    expect(await keyOf("c")).toBeUndefined();
    expect(await keyOf("d")).toBeUndefined();
    const doc = await db
      .collection("partitionedUsers")
      .findOne({ _id: "a" as never });
    expect(doc?.["version"]).toBe(1);
    expect(await backfillNameKeys(db)).toBe(0);
  });
});
