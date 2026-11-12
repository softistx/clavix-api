import { describe, expect, test } from "bun:test";
import { isTenantOwned } from "@softistx/mongo";
import { Glob } from "bun";
import type { IndexDescription } from "mongodb";
import * as appCollections from "@/modules/collections";
import { notes } from "~/notes";
import { tenantOwned } from "./owned";

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
const allowed = [
  "src/tenancy/",
  "src/migrations/",
  "src/modules/tenants/",
  "src/modules/resources/",
  "src/config/resources.ts",
];
// Where the platform `tenants` collection may be reached: every writer
// there goes through the service, which invalidates the resolver's cache.
const tenantsAllowed = [
  "src/modules/tenants/",
  "src/config/tenancy.ts",
  "src/migrations/",
];
// Every way platform code reaches a collection without `scopeToTenant()`:
// `mongo.db.<name>` (also after `const { db } = mongo`), `db["<name>"]`,
// destructuring (`const { <name> } = mongo.db`), an alias of the db object
// (`const d = mongo.db`), `getCollection(…<name>…)` and `<name>.raw`.
const direct = (names: string[]) => {
  const any = names.join("|");
  return [
    new RegExp(`\\bdb\\.(${any})\\b`),
    new RegExp(`\\bdb\\[\\s*["'\`](${any})["'\`]\\s*\\]`),
    new RegExp(`\\{[^}]*\\b(${any})\\b[^}]*\\}\\s*=\\s*(?:\\w+\\.)*db\\b`),
    new RegExp(`\\bgetCollection\\([^)]*\\b(${any})\\b`),
    new RegExp(`\\b(${any})\\.raw\\b`),
  ];
};
// The db object bound to another name, whose members the patterns above
// cannot follow.
const aliasesDb =
  /\b(?:const|let|var)\s+\w+\s*=\s*(?:\w+\.)*db\s*;?\s*(?:\n|$)/;
const reaches = (patterns: RegExp[], text: string) =>
  patterns.some((pattern) => pattern.test(text));

// Both the export key and the collection's `name` may differ (`userNotes` /
// "notes"), and code may use either.
const namesOf = (entries: [string, { name: string }][]) => [
  ...new Set(entries.flatMap(([key, definition]) => [key, definition.name])),
];
const ownedNames = namesOf(
  Object.entries(definitions).filter(([, definition]) =>
    isTenantOwned(definition),
  ),
);

async function offendersOf(
  patterns: RegExp[],
  permitted: string[],
  alias = false,
) {
  const offenders: string[] = [];
  for await (const path of new Glob("src/**/*.ts").scan(".")) {
    if (path.endsWith(".spec.ts")) continue;
    if (permitted.some((prefix) => path.startsWith(prefix))) continue;
    const text = await Bun.file(path).text();
    if (reaches(patterns, text) || (alias && aliasesDb.test(text))) {
      offenders.push(path);
    }
  }
  return offenders;
}

describe("source scan", () => {
  test("tenant-owned collections are reached only where it is allowed", async () => {
    expect(await offendersOf(direct(ownedNames), allowed, true)).toEqual([]);
  });

  test("no allowed module exports a tenant-owned collection bare", async () => {
    // `export const x = mongo.db.resources` would hand the unscoped collection
    // to any importer, past the scan above: export a bound function instead.
    const bare = new RegExp(
      `export\\s+(?:const|let|var)\\s+\\w+\\s*=\\s*(?:\\w+\\.)*db\\.(${ownedNames.join("|")})\\s*;`,
    );
    const offenders: string[] = [];
    for await (const path of new Glob("src/**/*.ts").scan(".")) {
      if (path.endsWith(".spec.ts")) continue;
      if (bare.test(await Bun.file(path).text())) offenders.push(path);
    }
    expect(offenders).toEqual([]);
    expect(bare.test("export const c = mongo.db.notes;")).toBe(true);
  });

  test("the tenants collection is reached only by its module, its wiring and the migrations", async () => {
    expect(await offendersOf(direct(["tenants"]), tenantsAllowed)).toEqual([]);
  });

  test("the names include the export key and the collection name", () => {
    expect(ownedNames).toContain("notes");
    expect(namesOf([["userNotes", { name: "notes" }]])).toEqual([
      "userNotes",
      "notes",
    ]);
  });

  test("the scan sees what it is meant to refuse", () => {
    const patterns = direct(["notes", "userNotes"]);
    for (const refused of [
      "await mongo.db.notes.findMany()",
      "await mongo.db.userNotes.findMany()",
      "scopeToTenant(mongo.db.notes, tenantId)",
      "const { db } = mongo; db.notes.findMany()",
      'mongo.db["notes"].findMany()',
      "mongo.db['userNotes']",
      "getCollection(mongo.db, notes)",
      "getCollection(db, userNotes, { autoSync: true })",
      "notes.raw.find()",
      "const { notes } = mongo.db;",
      "const { tenants, userNotes: n } = db;",
    ]) {
      expect(reaches(patterns, refused)).toBe(true);
    }
    for (const refused of [
      "const d = mongo.db;\nd.notes.find()",
      "let d = db;",
    ]) {
      expect(aliasesDb.test(refused)).toBe(true);
    }
    for (const fine of [
      "mongo.db.tenants.findMany()",
      'mongo.db["tenants"]',
      "getCollection(mongo.db, tenants)",
      "tenants.raw.find()",
      "const { tenants } = mongo.db;",
    ]) {
      expect(reaches(patterns, fine)).toBe(false);
    }
    expect(aliasesDb.test("const x = mongo.dbName;")).toBe(false);
  });

  test("the tenants scan sees what it is meant to refuse", () => {
    const patterns = direct(["tenants"]);
    for (const refused of [
      "mongo.db.tenants.update(id, patch)",
      'db["tenants"].delete(id)',
      "const { tenants } = mongo.db;",
      "getCollection(db, tenants).create(x)",
      "tenants.raw.updateOne()",
    ]) {
      expect(reaches(patterns, refused)).toBe(true);
    }
  });
});
