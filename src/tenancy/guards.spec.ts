import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import type { IndexDescription } from "mongodb";
import * as appCollections from "@/modules/collections";
import { notes } from "~/notes";
import { isTenantOwned, tenantOwned } from "./owned";

// The app's collections, and the test-only `notes` that stands for a
// tenant-owned one while 1.1 has none.
const definitions = { ...appCollections, notes };
const owned = tenantOwned(definitions);
const startsWithTenantId = (index: { key: IndexDescription["key"] }) =>
  (index.key instanceof Map
    ? [...index.key.keys()][0]
    : Object.keys(index.key)[0]) === "tenantId";

describe("tenant-owned collections", () => {
  // `isTenantOwned` reads `schema.shape`: a definition whose schema has none
  // (a wrapped or non-object schema) would be dropped from the guards without
  // a word, so it fails here instead.
  test("every definition has an object schema with a shape", () => {
    const shapeless = Object.entries(definitions)
      .filter(([, definition]) => !("shape" in definition.schema))
      .map(([key]) => key);
    expect(shapeless).toEqual([]);
  });

  test("the guard sees the collections it is meant to guard", () => {
    expect(owned.map((c) => c.name)).toContain("notes");
  });

  test("every index starts with tenantId", () => {
    const offenders = owned.flatMap((c) =>
      c.indexes
        .filter((index) => !startsWithTenantId(index))
        .map(
          (index) => `${c.name}: ${index.name ?? JSON.stringify(index.key)}`,
        ),
    );
    expect(offenders).toEqual([]);
  });

  test("the index check refuses an index that does not start with tenantId", () => {
    expect(startsWithTenantId({ key: { text: 1 } })).toBe(false);
    expect(startsWithTenantId({ key: { tenantId: 1, text: 1 } })).toBe(true);
    expect(isTenantOwned(notes)).toBe(true);
  });
});

// Where platform code may touch a tenant-owned collection directly.
const allowed = ["src/tenancy/", "src/migrations/", "src/modules/tenants/"];
// Every way platform code reaches a tenant-owned collection without
// `scoped()`: `mongo.db.<name>` (also after `const { db } = mongo`),
// `db["<name>"]`, `getCollection(…<name>…)` and `<name>.raw`.
const direct = (names: string[]) => {
  const any = names.join("|");
  return [
    new RegExp(`\\bdb\\.(${any})\\b`),
    new RegExp(`\\bdb\\[\\s*["'\`](${any})["'\`]\\s*\\]`),
    new RegExp(`\\bgetCollection\\([^)]*\\b(${any})\\b`),
    new RegExp(`\\b(${any})\\.raw\\b`),
  ];
};
const reaches = (patterns: RegExp[], text: string) =>
  patterns.some((pattern) => pattern.test(text));

describe("source scan", () => {
  test("tenant-owned collections are reached only where it is allowed", async () => {
    const patterns = direct(owned.map((c) => c.name));
    const offenders: string[] = [];
    for await (const path of new Glob("src/**/*.ts").scan(".")) {
      if (path.endsWith(".spec.ts")) continue;
      if (allowed.some((prefix) => path.startsWith(prefix))) continue;
      if (reaches(patterns, await Bun.file(path).text())) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  test("the scan sees what it is meant to refuse", () => {
    const patterns = direct(["notes"]);
    for (const refused of [
      "await mongo.db.notes.findMany()",
      "scoped(mongo.db.notes, tenantId)",
      "const { db } = mongo; db.notes.findMany()",
      'mongo.db["notes"].findMany()',
      "mongo.db['notes']",
      "getCollection(mongo.db, notes)",
      "getCollection(db, notes, { autoSync: true })",
      "notes.raw.find()",
    ]) {
      expect(reaches(patterns, refused)).toBe(true);
    }
    for (const fine of [
      "mongo.db.tenants.findMany()",
      'mongo.db["tenants"]',
      "getCollection(mongo.db, tenants)",
      "tenants.raw.find()",
    ]) {
      expect(reaches(patterns, fine)).toBe(false);
    }
  });
});
