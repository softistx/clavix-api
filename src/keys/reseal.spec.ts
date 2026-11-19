import { afterEach, describe, expect, test } from "bun:test";
import { StoreFailure } from "@softistx/janus";
import { mongo } from "@/config/db";
import { clearDatabase } from "~/db";
import { resealAllTenants, resealExitCode } from "./reseal";
import { ensureSigningKey } from "./rotation";
import { createTenantKeys } from "./signing-keys";

const oldKey = new Uint8Array(32).fill(1);
const newKey = new Uint8Array(32).fill(2);
const A = "a".repeat(24);
const B = "b".repeat(24);
const now = new Date("2026-11-12T12:00:00Z");
const under = (keys: Uint8Array[]) =>
  createTenantKeys({ db: mongo.db, masterKey: keys });
const quiet = () => {};

afterEach(clearDatabase);

describe("master-key rotation: [old] -> [new, old] -> reseal -> [new]", () => {
  test("reseals every tenant, then reports nothing left, and the new key alone opens them", async () => {
    const before = under([oldKey]);
    await ensureSigningKey(before.signingKeysFor, A, now);
    await ensureSigningKey(before.signingKeysFor, B, now);
    const kidA = (await before.signingKeysFor(A).findCurrentKey(now))?.kid;

    // Deploy [new, old]: both tenants still open.
    const ring = [newKey, oldKey];
    expect(
      await under(ring).signingKeysFor(A).findCurrentKey(now),
    ).toMatchObject({
      kid: kidA,
    });

    const deps = {
      db: mongo.db,
      masterKeys: ring as [Uint8Array, ...Uint8Array[]],
      tenantIds: async () => [A, B],
      log: quiet,
    };
    const first = await resealAllTenants(deps);
    expect(first).toMatchObject({
      tenants: 2,
      resealed: 2,
      skipped: 0,
      failed: 0,
    });
    expect(resealExitCode(first)).toBe(0);

    // Idempotent: the second run has nothing to do.
    const second = await resealAllTenants(deps);
    expect(second).toMatchObject({ resealed: 0, skipped: 0, failed: 0 });

    // Deploy [new] alone: the same key signs, the old key is no longer needed.
    const after = under([newKey]);
    expect((await after.signingKeysFor(A).findCurrentKey(now))?.kid).toBe(kidA);
    await expect(
      under([oldKey]).signingKeysFor(A).findCurrentKey(now),
    ).rejects.toBeInstanceOf(StoreFailure);
  });

  test("a tenant no key opens is counted as failed and the exit code is non-zero; the others are resealed", async () => {
    const stranger = new Uint8Array(32).fill(7);
    await ensureSigningKey(under([stranger]).signingKeysFor, A, now);
    await ensureSigningKey(under([oldKey]).signingKeysFor, B, now);
    const logs: string[] = [];
    const report = await resealAllTenants({
      db: mongo.db,
      masterKeys: [newKey, oldKey],
      tenantIds: async () => [A, B],
      log: (message) => logs.push(message),
    });
    expect(report).toMatchObject({ tenants: 2, resealed: 1, failed: 1 });
    expect(logs.join("\n")).toContain(A);
    expect(resealExitCode(report)).toBe(1);
  });

  test("skipped records make the exit code non-zero", () => {
    expect(
      resealExitCode({
        tenants: 1,
        resealed: 0,
        current: 0,
        skipped: 1,
        failed: 0,
        secondFactor: { sealed: 0, behind: 0 },
      }),
    ).toBe(1);
    expect(
      resealExitCode({
        tenants: 1,
        resealed: 0,
        current: 1,
        skipped: 0,
        failed: 0,
        secondFactor: { sealed: 0, behind: 0 },
      }),
    ).toBe(0);
  });
});
