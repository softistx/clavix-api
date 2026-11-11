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
const direct = (names: string[]) =>
  new RegExp(`\\bmongo\\.db\\.(${names.join("|")})\\b`);

describe("source scan", () => {
  test("mongo.db.<tenant-owned> appears only where it is allowed", async () => {
    const pattern = direct(owned.map((c) => c.name));
    const offenders: string[] = [];
    for await (const path of new Glob("src/**/*.ts").scan(".")) {
      if (path.endsWith(".spec.ts")) continue;
      if (allowed.some((prefix) => path.startsWith(prefix))) continue;
      if (pattern.test(await Bun.file(path).text())) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  test("the scan sees what it is meant to refuse", () => {
    const pattern = direct(["notes"]);
    expect(pattern.test("await mongo.db.notes.findMany()")).toBe(true);
    expect(pattern.test("scoped(mongo.db.notes, tenantId)")).toBe(true);
    expect(pattern.test("mongo.db.tenants.findMany()")).toBe(false);
  });
});
