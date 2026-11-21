import { afterEach, describe, expect, test } from "bun:test";
import { mongo } from "@/config/db";
import { clearDatabase } from "~/db";
import { quietKeys } from "~/ports";
import { createKeyGenerations } from "./keys.generations";
import { retireAfterMs, rotationPolicy } from "./keys.rules";
import { createTenantKeys } from "./keys.signing-keys";

describe("rotation", () => {
  const keys = createTenantKeys({
    db: mongo.db,
    masterKey: new Uint8Array(32).fill(3),
    generations: createKeyGenerations(),
  });
  const T = "t".repeat(24);
  const HOUR = 3_600_000;
  const t0 = new Date("2026-01-01T00:00:00Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);
  const kids = async (tenant: string, now: Date) =>
    (await keys.jwksFor(tenant, now)).keys.map((k) => k.kid);
  const signing = async (tenant: string, now: Date) =>
    (await keys.signingKeysFor(tenant).findCurrentKey(now))?.kid;

  afterEach(clearDatabase);

  describe("rotation lifecycle (90 d, 48 h lead, 24 h retirement)", () => {
    test("next -> current -> retired -> gone on a fixed clock", async () => {
      const pass = (now: Date) => quietKeys(keys).ensureSigningKey(T, now);

      // The first pass creates the first key, which signs at once.
      await pass(t0);
      const first = await signing(T, t0);
      expect(first).toBeDefined();
      expect(await kids(T, t0)).toEqual([first as string]);

      // Idempotent: a second pass does nothing.
      expect(await pass(at(HOUR))).toEqual({ inserted: [], promoted: [] });

      // 90 d - 48 h: the next key is published, still not signing.
      const publishAt = at(90 * 24 * HOUR - 48 * HOUR);
      expect(await pass(at(90 * 24 * HOUR - 49 * HOUR))).toEqual({
        inserted: [],
        promoted: [],
      });
      await pass(publishAt);
      const published = await kids(T, publishAt);
      expect(published).toHaveLength(2);
      const second = published.find((kid) => kid !== first) as string;
      expect(await signing(T, publishAt)).toBe(first);

      // 47 h later it is still waiting; at 90 d it takes over, the old one retires.
      await pass(at(90 * 24 * HOUR - HOUR));
      expect(await signing(T, at(90 * 24 * HOUR - HOUR))).toBe(first);
      const activation = at(90 * 24 * HOUR);
      const done = await pass(activation);
      expect(done.promoted).toEqual([second]);
      expect(await signing(T, activation)).toBe(second);
      expect(await kids(T, activation)).toEqual(
        expect.arrayContaining([first as string, second]),
      );

      // The retired key is published 24 h more, then gone.
      const justBefore = at(90 * 24 * HOUR + 23 * HOUR);
      expect(await kids(T, justBefore)).toContain(first as string);
      const gone = at(90 * 24 * HOUR + 25 * HOUR);
      expect(await kids(T, gone)).toEqual([second]);
    });
  });

  describe("rotateAll", () => {
    test("rotates every tenant it is given, and goes on past one that fails", async () => {
      const logged: string[] = [];
      const U = "u".repeat(24);
      const broken = {
        ...keys,
        signingKeysFor: (id: string) => {
          if (id === "bad") throw new Error("boom");
          return keys.signingKeysFor(id);
        },
      };
      const result = await quietKeys(
        broken,
        () => t0,
        (message) => logged.push(message),
      ).rotateAll([T, "bad", U]);
      expect(result).toEqual({ rotated: 2, failed: 1 });
      expect(logged).toEqual(["keys: rotation failed for tenant bad: boom"]);
      expect(await kids(T, t0)).toHaveLength(1);
      expect(await kids(U, t0)).toHaveLength(1);
    });
  });
});

describe("emergency rotation", () => {
  const keys = createTenantKeys({
    db: mongo.db,
    masterKey: new Uint8Array(32).fill(5),
    generations: createKeyGenerations(),
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
      await quietKeys(keys).ensureSigningKey(A, t0);
      await quietKeys(keys).ensureSigningKey(B, t0);
      const oldA = await signing(A, t0);
      const oldB = await signing(B, t0);

      const at = new Date(t0.getTime() + 1000);
      const { rotated, failed } = await quietKeys(keys, () => at).rotateNow([
        A,
      ]);
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
      await quietKeys(keys).ensureSigningKey(A, t0);
      const oldA = await signing(A, t0);
      const at = new Date(t0.getTime() + 1000);
      await quietKeys(keys, () => at).rotateNow([A], { dropOld: true });
      const published = await kids(A, new Date(at.getTime() + 1));
      expect(published).not.toContain(oldA as string);
      expect(published).toHaveLength(1);
      expect(published[0]).toBe((await signing(A, at)) as string);
    });

    test("a published next key takes over at once", async () => {
      await quietKeys(keys).ensureSigningKey(A, t0);
      const oldA = await signing(A, t0);
      // 90 d - 48 h later the next key is published, not yet signing.
      const pre = new Date(t0.getTime() + (90 * 24 - 48) * 3_600_000);
      await quietKeys(keys).ensureSigningKey(A, pre);
      const [, next] = await kids(A, pre);
      expect(next).toBeDefined();
      await quietKeys(keys, () => pre).rotateNow([A]);
      expect(await signing(A, pre)).toBe(next as string);
      expect(await kids(A, pre)).toContain(oldA as string);
    });

    test("a tenant with no key gets one; a failing tenant is counted and the others go on", async () => {
      const logs: string[] = [];
      const broken = {
        ...keys,
        signingKeysFor: (id: string) => {
          if (id === A) throw new Error("boom");
          return keys.signingKeysFor(id);
        },
      };
      const { rotated, failed } = await quietKeys(
        broken,
        () => t0,
        (message) => logs.push(message),
      ).rotateNow([A, B]);
      expect(failed).toBe(1);
      expect(logs[0]).toContain(A);
      expect(rotated).toHaveLength(1);
      expect(rotated[0]).toMatchObject({ tenantId: B, retired: null });
      expect(rotated[0]?.current).toBe((await signing(B, t0)) as string);
    });
  });

  test("retireAfterMs is the policy's retireAfter", () => {
    expect(rotationPolicy.retireAfter).toBe("24h");
    expect(retireAfterMs).toBe(24 * 3_600_000);
  });
});
