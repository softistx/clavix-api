import { afterEach, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { createSecretBox } from "@/modules/sign-in-methods/secrets";
import { QuotaExceededError } from "@/modules/usage/quota";
import type { UrlPolicy } from "./url-policy";
import {
  GIVE_UP_LIMIT,
  ROLL_OVERLAP_MS,
  WebhookEndpointsService,
} from "./webhook-endpoints.service";
import { WebhookError } from "./webhooks.errors";

const collection = mongo.db.webhookEndpoints;
const policy: UrlPolicy = {
  allowPrivate: false,
  resolve: async () => ["93.184.216.34"],
};
let clock = new Date("2026-11-18T12:00:00Z");
let counter = 0;
const service = new WebhookEndpointsService(
  collection,
  createSecretBox(
    crypto.getRandomValues(new Uint8Array(32)),
    "webhook-secrets",
  ),
  {
    policy,
    now: () => clock,
    mint: () => `whsec_test${++counter}`,
    log: () => {},
  },
);
const A = new ObjectId().toHexString();
const B = new ObjectId().toHexString();
const URL_A = "https://hooks.example.com/in";

afterEach(async () => {
  clock = new Date("2026-11-18T12:00:00Z");
  await collection.raw.deleteMany({});
});

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WebhookError) return error.code;
    if (error instanceof QuotaExceededError) return "QUOTA";
    return String(error);
  }
  return "none";
};

describe("create", () => {
  test("returns the secret once and stores it sealed", async () => {
    const { endpoint, secret } = await service.create(A, { url: URL_A }, 2);
    expect(secret).toStartWith("whsec_");
    expect(JSON.stringify(endpoint)).not.toContain(secret);
    const [delivery] = await service.deliveryEndpoints(A);
    expect(delivery?.secrets).toEqual([secret]);
    expect(delivery?.disabled).toBe(false);
  });
  test("refuses an unsafe URL", async () => {
    expect(
      await codeOf(service.create(A, { url: "http://x.example.com" }, 2)),
    ).toBe("BAD_USER_INPUT");
  });
  test("stops at the quota", async () => {
    await service.create(A, { url: URL_A }, 2);
    await service.create(A, { url: `${URL_A}2` }, 2);
    expect(await codeOf(service.create(A, { url: `${URL_A}3` }, 2))).toBe(
      "QUOTA",
    );
    // Another tenant has its own count.
    await service.create(B, { url: URL_A }, 2);
  });
});

describe("tenant isolation", () => {
  test("another tenant neither sees nor changes the endpoint", async () => {
    const { endpoint } = await service.create(A, { url: URL_A }, 2);
    const id = endpoint._id.toHexString();
    expect(await service.list(B)).toEqual([]);
    expect(await service.deliveryEndpoints(B)).toEqual([]);
    expect(await codeOf(service.update(B, id, { enabled: false }))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(service.delete(B, id))).toBe("NOT_FOUND");
    expect(await codeOf(service.roll(B, id, true))).toBe("NOT_FOUND");
    expect(await service.count(A)).toBe(1);
  });
});

describe("roll", () => {
  test("keepPrevious signs with both secrets for 24 hours, then only the new", async () => {
    const created = await service.create(A, { url: URL_A }, 2);
    const id = created.endpoint._id.toHexString();
    const rolled = await service.roll(A, id, true);
    expect(rolled.secret).not.toBe(created.secret);
    const both = (await service.deliveryEndpoints(A))[0]?.secrets;
    expect(both).toEqual([rolled.secret, created.secret]);
    clock = new Date(clock.getTime() + ROLL_OVERLAP_MS + 1);
    const after = (await service.deliveryEndpoints(A))[0]?.secrets;
    expect(after).toEqual([rolled.secret]);
    expect(await service.pruneExpiredSecrets(A)).toBe(1);
    expect((await service.find(A, id))?.secrets).toHaveLength(1);
  });
  test("without keepPrevious the old secret is gone at once", async () => {
    const created = await service.create(A, { url: URL_A }, 2);
    const rolled = await service.roll(
      A,
      created.endpoint._id.toHexString(),
      false,
    );
    expect((await service.deliveryEndpoints(A))[0]?.secrets).toEqual([
      rolled.secret,
    ]);
  });
});

describe("give-ups", () => {
  test("the fifth in a row disables the endpoint, once", async () => {
    const { endpoint } = await service.create(A, { url: URL_A }, 2);
    const id = endpoint._id.toHexString();
    const results: boolean[] = [];
    for (let i = 0; i < GIVE_UP_LIMIT; i++) {
      results.push(await service.recordGiveUp(A, id));
    }
    expect(results).toEqual([false, false, false, false, true]);
    const stored = await service.find(A, id);
    expect(stored?.enabled).toBe(false);
    expect(stored?.disabledReason).toBe("givenUp");
    expect(await service.recordGiveUp(A, id)).toBe(false);
  });
  test("a delivery resets the run; re-enabling clears the reason", async () => {
    const { endpoint } = await service.create(A, { url: URL_A }, 2);
    const id = endpoint._id.toHexString();
    for (let i = 0; i < 4; i++) await service.recordGiveUp(A, id);
    await service.recordDelivered(A, id);
    expect(await service.recordGiveUp(A, id)).toBe(false);
    for (let i = 0; i < 4; i++) await service.recordGiveUp(A, id);
    expect((await service.find(A, id))?.enabled).toBe(false);
    const back = await service.update(A, id, { enabled: true });
    expect(back.enabled).toBe(true);
    expect(back.disabledReason).toBeNull();
    expect(back.consecutiveGiveUps).toBe(0);
  });
});
