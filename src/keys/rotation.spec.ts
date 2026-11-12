import { afterEach, describe, expect, test } from "bun:test";
import { mongo } from "@/config/db";
import { clearDatabase } from "~/db";
import { ensureSigningKey, rotateAllTenants } from "./rotation";
import { createTenantKeys } from "./signing-keys";

const keys = createTenantKeys({
  db: mongo.db,
  masterKey: new Uint8Array(32).fill(3),
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
    const pass = (now: Date) => ensureSigningKey(keys.signingKeysFor, T, now);

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

describe("rotateAllTenants", () => {
  test("rotates every tenant it is given, and goes on past one that fails", async () => {
    const logged: string[] = [];
    const U = "u".repeat(24);
    const result = await rotateAllTenants({
      signingKeysFor: (id) => {
        if (id === "bad") throw new Error("boom");
        return keys.signingKeysFor(id);
      },
      activeTenantIds: async () => [T, "bad", U],
      now: () => t0,
      log: (message) => logged.push(message),
    });
    expect(result).toEqual({ rotated: 2, failed: 1 });
    expect(logged).toEqual(["keys: rotation failed for tenant bad: boom"]);
    expect(await kids(T, t0)).toHaveLength(1);
    expect(await kids(U, t0)).toHaveLength(1);
  });
});
