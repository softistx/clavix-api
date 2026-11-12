import { afterEach, describe, expect, test } from "bun:test";
import { StoreFailure } from "@softistx/janus";
import { mongo } from "@/config/db";
import { clearDatabase } from "~/db";
import { ensureSigningKey } from "./rotation";
import { createTenantKeys } from "./signing-keys";

const masterKey = new Uint8Array(32).fill(1);
const keys = createTenantKeys({ db: mongo.db, masterKey });
const now = new Date("2026-11-12T12:00:00Z");
const A = "a".repeat(24);
const B = "b".repeat(24);

afterEach(clearDatabase);

describe("tenant signing keys", () => {
  test("a tenant's JWKS holds its own kid and no private member", async () => {
    await ensureSigningKey(keys.signingKeysFor, A, now);
    const { keys: published } = await keys.jwksFor(A, now);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kty: "EC", alg: "ES256", use: "sig" });
    expect(published[0]).not.toHaveProperty("d");
  });

  test("A's kid is never in B's JWKS, and B's store cannot read A's private key", async () => {
    await ensureSigningKey(keys.signingKeysFor, A, now);
    await ensureSigningKey(keys.signingKeysFor, B, now);
    const kidA = (await keys.jwksFor(A, now)).keys[0]?.kid;
    const kidB = (await keys.jwksFor(B, now)).keys[0]?.kid;
    expect(kidA).toBeDefined();
    expect(kidA).not.toBe(kidB);
    expect((await keys.jwksFor(B, now)).keys.map((k) => k.kid)).not.toContain(
      kidA,
    );

    const currentA = await keys.signingKeysFor(A).findCurrentKey(now);
    const currentB = await keys.signingKeysFor(B).findCurrentKey(now);
    expect(currentA?.kid).toBe(kidA);
    expect(currentB?.kid).toBe(kidB);
    expect(
      (await keys.signingKeysFor(B).findKeys(now)).map((k) => k.kid),
    ).toEqual([kidB as string]);
    // Neither does a tenant with no key see another's.
    expect((await keys.jwksFor("c".repeat(24), now)).keys).toEqual([]);
  });

  test("the private JWK is encrypted at rest and a wrong master key cannot read it", async () => {
    await ensureSigningKey(keys.signingKeysFor, A, now);
    const raw = await mongo.db.oauthSigningKeys.raw.find({}).toArray();
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw[0])).not.toContain('"d":');
    const other = createTenantKeys({
      db: mongo.db,
      masterKey: new Uint8Array(32).fill(2),
    });
    await expect(other.signingKeysFor(A).findKeys(now)).rejects.toThrow(
      StoreFailure,
    );
    // The public side never decrypts: the JWKS still serves.
    expect((await other.jwksFor(A, now)).keys).toHaveLength(1);
  });

  test("an empty tenant id is refused", () => {
    expect(() => keys.signingKeysFor("")).toThrow(TypeError);
  });
});
