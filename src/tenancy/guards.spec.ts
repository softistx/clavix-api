import { describe, expect, test } from "bun:test";
import { isTenantOwned } from "@softistx/mongo";
import { Glob } from "bun";
import type { IndexDescription } from "mongodb";
import * as appCollections from "@/modules/collections";
import { notes } from "~/notes";
import { isOwned, platformCollections, tenantOwned } from "./owned";

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

  test("the platform collections with a tenantId are the listed ones only", () => {
    expect(platformCollections).toEqual(["adminEvents", "domains"]);
    expect(owned.map((c) => c.name)).not.toContain("adminEvents");
    expect(isTenantOwned(appCollections.adminEvents)).toBe(true);
    expect(isOwned(appCollections.adminEvents)).toBe(false);
    expect(isOwned(notes)).toBe(true);
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
  "src/modules/branding/",
  "src/modules/roles/",
  "src/config/roles.ts",
  "src/config/branding.ts",
  "src/modules/usage/",
  "src/config/usage.ts",
  "src/config/purge.ts",
  "src/modules/client-policies/",
  "src/config/client-policies.ts",
];
// Where a platform collection with a `tenantId` (owned.ts) may be reached:
// `adminEvents` by its recorder and the recorder's wiring, nowhere else.
const platformAllowed = [
  "src/console/admin-events/",
  "src/config/admin-events.ts",
  "src/modules/domains/",
  "src/config/domains.ts",
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
  Object.entries(definitions).filter(([, definition]) => isOwned(definition)),
);

const platformNames = namesOf(
  Object.entries(definitions).filter(([, definition]) =>
    platformCollections.includes(definition.name),
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

/** Whether a source exposes a tenant-owned collection through an export. */
function exposesOwned(text: string, of: string[] = ownedNames) {
  const names = of.join("|");
  const owned = new RegExp(`\\bdb\\.(?:${names})\\b`);
  // A call argument (`bind(db.notes)`) is a binding, not an exposure.
  const bound = new RegExp(`\\(\\s*(?:\\w+\\.)*db\\.(?:${names})\\s*[,)]`, "g");
  const exposed = (code: string) => owned.test(code.replace(bound, "("));
  const lines = text.split("\n");
  if (lines.some((line) => /^\s*export\b/.test(line) && exposed(line))) {
    return true;
  }
  const locals = [...text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*([^;]*)/g)]
    .filter(([, , value]) => exposed(value ?? ""))
    .map(([, name]) => name);
  return [...text.matchAll(/export\s*\{([^}]*)\}/g)].some(([, list]) =>
    (list ?? "")
      .split(",")
      .some((item) => locals.includes(item.trim().split(/\s+/)[0] ?? "")),
  );
}

describe("source scan", () => {
  test("tenant-owned collections are reached only where it is allowed", async () => {
    expect(await offendersOf(direct(ownedNames), allowed, true)).toEqual([]);
  });

  test("no allowed module exports a tenant-owned collection", async () => {
    // Exporting `mongo.db.resources` (bare, `.raw`, in an arrow, or through a
    // local and `export { x }`) hands the unscoped collection to any importer,
    // past the scan above: export a function bound to the scope instead.
    const offenders: string[] = [];
    for await (const path of new Glob("src/**/*.ts").scan(".")) {
      if (path.endsWith(".spec.ts")) continue;
      if (exposesOwned(await Bun.file(path).text())) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  test("the export scan sees what it is meant to refuse", () => {
    for (const refused of [
      "export const c = mongo.db.notes;",
      "export const c = mongo.db.notes.raw;",
      "export const c = () => db.notes;",
      "export const c = () => mongo.db.notes.raw;",
      "const x = db.notes;\nexport { x };",
      "const x = mongo.db.notes.raw;\nexport { x as y, z };",
    ]) {
      expect(exposesOwned(refused), refused).toBe(true);
    }
    for (const allowed of [
      "export const f = bind(mongo.db.notes);",
      "const x = bind(db.notes);\nexport { x };",
    ]) {
      expect(exposesOwned(allowed), allowed).toBe(false);
    }
  });

  test("the tenants collection is reached only by its module, its wiring and the migrations", async () => {
    expect(await offendersOf(direct(["tenants"]), tenantsAllowed)).toEqual([]);
  });

  // Append-only by construction (ADR-0037): `adminEvents` is bound in one
  // place and written by its recorder alone, and never exported.
  test("the platform collections are reached only by their recorder and its wiring", async () => {
    expect(platformNames).toContain("adminEvents");
    expect(platformNames).toContain("domains");
    expect(
      await offendersOf(direct(platformNames), platformAllowed, true),
    ).toEqual([]);
    const exposing: string[] = [];
    for await (const path of new Glob("src/**/*.ts").scan(".")) {
      if (path.endsWith(".spec.ts")) continue;
      if (exposesOwned(await Bun.file(path).text(), platformNames)) {
        exposing.push(path);
      }
    }
    expect(exposing).toEqual([]);
  });

  test("the platform scan sees what it is meant to refuse", () => {
    const patterns = direct(platformNames);
    for (const refused of [
      "mongo.db.adminEvents.update(id, patch)",
      'db["adminEvents"].delete(id)',
      "const { adminEvents } = mongo.db;",
      "const { adminEvents: events } = db;",
      "getCollection(db, adminEvents).create(x)",
      "adminEvents.raw.deleteMany({})",
    ]) {
      expect(reaches(patterns, refused), refused).toBe(true);
    }
    for (const refused of [
      "export const events = mongo.db.adminEvents;",
      "const x = mongo.db.adminEvents.raw;\nexport { x };",
    ]) {
      expect(exposesOwned(refused, platformNames), refused).toBe(true);
    }
    for (const fine of [
      "adminEvents.record(event)",
      'export { adminEvents } from "../console/admin-events/admin-events.model";',
    ]) {
      expect(reaches(patterns, fine), fine).toBe(false);
      expect(exposesOwned(fine, platformNames), fine).toBe(false);
    }
    // The wiring (an allowed path) binds the collection without exporting it.
    expect(
      exposesOwned(
        "export const r = createAdminEventRecorder(\n  mongo.db.adminEvents,\n);",
        platformNames,
      ),
    ).toBe(false);
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
