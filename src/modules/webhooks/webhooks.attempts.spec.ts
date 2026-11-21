import { afterEach, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { createSecretBox } from "@/modules/sign-in-methods/secrets";
import {
  DELIVERIES_PER_ENDPOINT,
  DELIVERY_RETENTION_SECONDS,
} from "./webhooks.model";
import { WebhooksService } from "./webhooks.service";
import type { AttemptRecord } from "./webhooks.types";

const service = new WebhooksService(
  mongo.db.webhookEndpoints,
  mongo.db.webhookDeliveries,
  createSecretBox(
    crypto.getRandomValues(new Uint8Array(32)),
    "webhook-secrets",
  ),
  { policy: { allowPrivate: false, resolve: async () => [] } },
);
const A = new ObjectId().toHexString();
const B = new ObjectId().toHexString();
const E1 = new ObjectId().toHexString();
const E2 = new ObjectId().toHexString();

const attempt = (endpointId: string, n = 1): AttemptRecord => ({
  endpointId,
  eventId: `evt-${n}`,
  type: "user.created",
  attempt: n,
  status: 500,
  error: null,
  durationMs: 12.4,
  delivered: false,
  willRetry: true,
});

afterEach(async () => {
  await mongo.db.webhookDeliveries.raw.deleteMany({});
});

describe("webhookDeliveries", () => {
  test("an attempt is recorded and listed newest first, with no body or URL", async () => {
    await service.recordAttempt(A, attempt(E1, 1));
    await service.recordAttempt(A, {
      ...attempt(E1, 2),
      status: null,
      error: "TimeoutError",
    });
    const rows = await service.listAttempts(A, E1);
    expect(rows.map((row) => row.attempt)).toEqual([2, 1]);
    expect(rows[0]).toMatchObject({
      status: null,
      error: "TimeoutError",
      durationMs: 12,
      eventId: "evt-2",
      type: "user.created",
    });
    const keys = Object.keys(
      (await mongo.db.webhookDeliveries.raw.findOne({})) ?? {},
    ).sort();
    expect(keys).toEqual(
      [
        "_id",
        "at",
        "attempt",
        "delivered",
        "durationMs",
        "endpointId",
        "error",
        "eventId",
        "status",
        "tenantId",
        "type",
        "willRetry",
      ].sort(),
    );
  });

  test("keeps the newest 100 per endpoint, other endpoints untouched", async () => {
    await service.recordAttempt(A, attempt(E2, 1));
    for (let n = 1; n <= DELIVERIES_PER_ENDPOINT + 5; n++) {
      await service.recordAttempt(A, attempt(E1, n));
    }
    const rows = await service.listAttempts(A, E1, 1000);
    expect(rows).toHaveLength(DELIVERIES_PER_ENDPOINT);
    expect(rows[0]?.attempt).toBe(DELIVERIES_PER_ENDPOINT + 5);
    expect(rows.at(-1)?.attempt).toBe(6);
    expect(await service.listAttempts(A, E2)).toHaveLength(1);
  });

  test("another tenant never sees them", async () => {
    await service.recordAttempt(A, attempt(E1));
    expect(await service.listAttempts(B, E1)).toEqual([]);
    await service.deleteAttempts(B, E1);
    expect(await service.listAttempts(A, E1)).toHaveLength(1);
    await service.deleteAttempts(A, E1);
    expect(await service.listAttempts(A, E1)).toEqual([]);
  });

  test("a TTL index drops attempts after 7 days", async () => {
    const index = (await mongo.db.webhookDeliveries.raw.indexes()).find(
      (candidate) => candidate.name === "webhookDeliveries_ttl",
    );
    expect(index?.key).toEqual({ at: 1 });
    expect(index?.expireAfterSeconds).toBe(DELIVERY_RETENTION_SECONDS);
    expect(DELIVERY_RETENTION_SECONDS).toBe(7 * 24 * 3600);
  });
});
