import { describe, expect, test } from "bun:test";
import { migrationsOf } from ".";

const options = {
  origin: { scheme: "https", domain: "clavix.test" },
  announce: () => undefined,
} as const;

describe("migrationsOf", () => {
  test("lists the migrations oldest first, each id once", () => {
    const ids = migrationsOf(options).map((migration) => migration.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });

  test("starts with the clavix tenant, then the console seed", () => {
    const ids = migrationsOf(options).map((migration) => migration.id);
    expect(ids.slice(0, 2)).toEqual([
      "2026-11-10-clavix-tenant",
      "2026-11-12-console",
    ]);
  });
});
