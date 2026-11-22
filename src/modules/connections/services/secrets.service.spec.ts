import { afterEach, describe, expect, test } from "bun:test";
import { connectionsHarness } from "~/connections-service";

const {
  collection,
  records,
  secrets,
  sources,
  state,
  input,
  codeOf,
  verified,
  reset,
  A,
  B,
} = connectionsHarness();

afterEach(reset);

describe("setSecret", () => {
  test("a new secret replaces the sealed one", async () => {
    await records.create(A, input(), null);
    await verified(A);
    const before = await records.find(A, "acme");
    await secrets.setSecret(A, "acme", "brand-new-secret");
    const found = await sources.sourceOf(A).findConnection("acme");
    expect(found?.client.secret).toBe("brand-new-secret");
    expect((await records.find(A, "acme"))?.revision).toBe(
      (before?.revision ?? 0) + 1,
    );
    expect(
      JSON.stringify(await collection.raw.find({}).toArray()),
    ).not.toContain("brand-new-secret");
  });

  test("a secret janus refuses is refused, and another tenant's connection is unknown", async () => {
    await records.create(A, input(), null);
    expect(await codeOf(secrets.setSecret(A, "acme", ""))).toBe(
      "BAD_USER_INPUT",
    );
    expect(await codeOf(secrets.setSecret(B, "acme", "x-secret"))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("resealSecrets", () => {
  test("a secret already under the current key is counted and left alone", async () => {
    await records.create(A, input(), null);
    await records.create(A, input({ id: "two" }), null);
    const counts = await secrets.resealSecrets(A);
    expect(counts.scanned).toBe(2);
    expect(counts.current).toBe(2);
    expect(counts.resealed).toBe(0);
    expect(counts.behind).toBe(0);
    expect(state.logged).toEqual([]);
  });

  test("a secret no key opens is counted and logged by connection id only", async () => {
    await records.create(A, input(), null);
    await collection.raw.updateMany(
      {},
      { $set: { "secret.kid": "retired-key" } },
    );
    const counts = await secrets.resealSecrets(A);
    expect(counts.unreadable).toBe(1);
    expect(counts.behind).toBe(1);
    expect(state.logged.join("\n")).toContain("acme");
    expect(state.logged.join("\n")).not.toContain("s3cr3t-value");
  });
});
