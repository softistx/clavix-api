import { afterEach, describe, expect, test } from "bun:test";
import { mongo } from "@/config/db";
import { clearDatabase } from "~/db";
import { rotateNow } from "./emergency";
import { retireAfterMs } from "./policy";
import { ensureSigningKey } from "./rotation";
import { createTenantKeys } from "./signing-keys";

const keys = createTenantKeys({
  db: mongo.db,
  masterKey: new Uint8Array(32).fill(5),
});
const A = "a".repeat(24);
const B = "b".repeat(24);
const t0 = new Date("2026-11-12T12:00:00Z");
const kids = async (tenant: string, at: Date) =>
  (await keys.jwksFor(tenant, at)).keys.map((k) => k.kid);
const signing = async (tenant: string, at: Date) =>
  (await keys.signingKeysFor(tenant).findCurrentKey(at))?.kid;

afterEach(clearDatabase);

describe("emergency rotation", () => {
  test("a new key signs at once and the old one stays published for the retirement window", async () => {
    await ensureSigningKey(keys.signingKeysFor, A, t0);
    await ensureSigningKey(keys.signingKeysFor, B, t0);
    const oldA = await signing(A, t0);
    const oldB = await signing(B, t0);

    const at = new Date(t0.getTime() + 1000);
    const { rotated, failed } = await rotateNow({
      signingKeysFor: keys.signingKeysFor,
      tenantIds: [A],
      now: () => at,
    });
    expect(failed).toBe(0);
    expect(rotated).toHaveLength(1);
    expect(rotated[0]).toMatchObject({ tenantId: A, retired: oldA });

    const newA = await signing(A, at);
    expect(newA).toBeDefined();
    expect(newA).not.toBe(oldA);
    expect(rotated[0]?.current).toBe(newA as string);
    expect(await kids(A, at)).toEqual(
      expect.arrayContaining([oldA as string, newA as string]),
    );

    // The old key leaves the JWKS after the window, not before.
    const justBefore = new Date(at.getTime() + retireAfterMs - 1);
    expect(await kids(A, justBefore)).toContain(oldA as string);
    const after = new Date(at.getTime() + retireAfterMs + 1);
    expect(await kids(A, after)).not.toContain(oldA as string);

    // The other tenant is untouched.
    expect(await signing(B, at)).toBe(oldB as string);
  });

  test("--drop-old unpublishes the retired key at once", async () => {
    await ensureSigningKey(keys.signingKeysFor, A, t0);
    const oldA = await signing(A, t0);
    const at = new Date(t0.getTime() + 1000);
    await rotateNow({
      signingKeysFor: keys.signingKeysFor,
      tenantIds: [A],
      dropOld: true,
      now: () => at,
    });
    const published = await kids(A, new Date(at.getTime() + 1));
    expect(published).not.toContain(oldA as string);
    expect(published).toHaveLength(1);
    expect(published[0]).toBe((await signing(A, at)) as string);
  });

  test("a published next key takes over at once", async () => {
    await ensureSigningKey(keys.signingKeysFor, A, t0);
    const oldA = await signing(A, t0);
    // 90 d - 48 h later the next key is published, not yet signing.
    const pre = new Date(t0.getTime() + (90 * 24 - 48) * 3_600_000);
    await ensureSigningKey(keys.signingKeysFor, A, pre);
    const [, next] = await kids(A, pre);
    expect(next).toBeDefined();
    await rotateNow({
      signingKeysFor: keys.signingKeysFor,
      tenantIds: [A],
      now: () => pre,
    });
    expect(await signing(A, pre)).toBe(next as string);
    expect(await kids(A, pre)).toContain(oldA as string);
  });

  test("a tenant with no key gets one; a failing tenant is counted and the others go on", async () => {
    const logs: string[] = [];
    const broken = (id: string) => {
      if (id === A) throw new Error("boom");
      return keys.signingKeysFor(id);
    };
    const { rotated, failed } = await rotateNow({
      signingKeysFor: broken,
      tenantIds: [A, B],
      now: () => t0,
      log: (message) => logs.push(message),
    });
    expect(failed).toBe(1);
    expect(logs[0]).toContain(A);
    expect(rotated).toHaveLength(1);
    expect(rotated[0]).toMatchObject({ tenantId: B, retired: null });
    expect(rotated[0]?.current).toBe((await signing(B, t0)) as string);
  });
});
