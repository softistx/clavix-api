import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { freshMigrationDb } from "~/migrations";
import {
  id,
  migrateOAuthPolicy,
  oauthPolicyMigration,
} from "./2026-11-16-oauth-policy.migration";

let db: Db;
const put = (slug: string, extra: Record<string, unknown> = {}) =>
  db.collection("tenants").insertOne({
    slug,
    name: slug,
    status: "active",
    signUp: false,
    version: 3,
    ...extra,
  });
const oauthOf = async (slug: string) =>
  (await db.collection("tenants").findOne({ slug }))?.["oauth"];

beforeEach(async () => {
  db = await freshMigrationDb();
});

describe(id, () => {
  test("writes an explicit false on a tenant that has no policy, and leaves a set one alone", async () => {
    await put("old");
    await put("set", {
      oauth: { par: { required: true }, dpop: { required: false } },
    });
    await migrate(db, [oauthPolicyMigration]);
    expect(await oauthOf("old")).toEqual({
      par: { required: false },
      dpop: { required: false },
    });
    expect(await oauthOf("set")).toEqual({
      par: { required: true },
      dpop: { required: false },
    });
  });

  test("moves neither the version nor anything else, and a second run changes nothing", async () => {
    await put("old");
    expect(await migrateOAuthPolicy(db)).toBe(1);
    const stored = await db.collection("tenants").findOne({ slug: "old" });
    expect(stored?.["version"]).toBe(3);
    expect(await migrateOAuthPolicy(db)).toBe(0);
  });
});
