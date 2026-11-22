import { describe, expect, test } from "bun:test";
import { endpointDoc, sealedUnder } from "~/webhook-docs";
import type { ClavixWebhookEvent } from "./webhooks.events";
import type { EndpointSecret } from "./webhooks.model";
import { TEST_EVENT_TYPE } from "./webhooks.rules";
import type { AttemptRecord, DeliveryEndpoint } from "./webhooks.types";
import {
  attemptDoc,
  attemptRecordOf,
  behindCount,
  contextOf,
  deliveryEndpointOf,
  endpointIdOf,
  queuedEndpoints,
  queueEndpointId,
  testEventOf,
  webhookGroupOf,
  webhookQueueLimits,
} from "./webhooks.utils";

const doc = endpointDoc;

describe("contextOf", () => {
  test("binds a secret to its tenant and endpoint", () => {
    expect(contextOf("t1", "e1")).toBe("t1:e1");
  });
});

describe("deliveryEndpointOf", () => {
  test("has no endpoint without a secret", () => {
    expect(deliveryEndpointOf(doc(), [])).toBeUndefined();
  });

  test("lists every secret, and the types only when some are set", () => {
    const all = doc();
    expect(deliveryEndpointOf(all, ["a", "b"])).toEqual({
      id: all._id.toHexString(),
      url: all.url,
      secrets: ["a", "b"],
      disabled: false,
    });
    const some = doc({ types: ["user.created"], enabled: false });
    expect(deliveryEndpointOf(some, ["a"])).toMatchObject({
      types: ["user.created"],
      disabled: true,
    });
  });
});

describe("behindCount", () => {
  test("counts the secrets sealed under another key", () => {
    const entry = (kid: string): EndpointSecret => ({
      sid: kid,
      sealed: sealedUnder(kid),
      createdAt: new Date(),
      expiresAt: null,
    });
    expect(behindCount([entry("k1"), entry("k2"), entry("k2")], "k2")).toBe(1);
    expect(behindCount([], "k2")).toBe(0);
  });
});

describe("attemptDoc", () => {
  test("rounds the duration and never lets it go negative", () => {
    const at = new Date("2026-11-18T12:00:00Z");
    const attempt = {
      endpointId: "e",
      eventId: "v",
      type: "user.created",
      attempt: 1,
      status: 200,
      error: null,
      durationMs: 12.6,
      delivered: true,
      willRetry: false,
    } satisfies AttemptRecord;
    expect(attemptDoc(attempt, at)).toMatchObject({ durationMs: 13, at });
    expect(attemptDoc({ ...attempt, durationMs: -4 }, at).durationMs).toBe(0);
  });
});

describe("queue names", () => {
  test("prefix an endpoint with its tenant and read both back", () => {
    const name = queueEndpointId("t1", "e1");
    expect(name).toBe("t1.e1");
    expect(webhookGroupOf(name)).toBe("t1");
    expect(endpointIdOf(name)).toBe("e1");
  });

  test("a name with no dot is its own group and its own endpoint", () => {
    expect(webhookGroupOf("e1")).toBe("e1");
    expect(endpointIdOf("e1")).toBe("e1");
  });
});

describe("webhookQueueLimits", () => {
  test("groups by tenant and reports a refusal by ids only", async () => {
    const lines: string[] = [];
    const limits = webhookQueueLimits(
      { maxInFlight: 2, maxPending: 7 },
      (line) => lines.push(line),
    );
    expect(limits.maxInFlight).toBe(2);
    expect(limits.groupOf?.("t1.e1")).toBe("t1");
    await limits.onRefused?.({
      event: testEventOf("t1", "e1", new Date()),
      endpoint: "t1.e1",
      group: "t1",
      maxPending: 7,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^webhooks: delivery .+ refused, tenant t1 holds 7$/,
    );
  });
});

describe("queuedEndpoints", () => {
  const endpoint = (id: string, types?: string[]): DeliveryEndpoint => ({
    id,
    url: `https://${id}.example/hook`,
    secrets: ["s"],
    ...(types === undefined ? {} : { types }),
    disabled: false,
  });
  const event = (type: string, endpointId?: string): ClavixWebhookEvent => ({
    id: "v1",
    type,
    occurredAt: new Date(),
    data: {
      tenantId: "t1",
      ...(endpointId === undefined ? {} : { endpointId }),
    },
  });

  test("names every endpoint after its tenant for a catalogue event", () => {
    const a = endpoint("a", ["user.created"]);
    const b = endpoint("b");
    expect(queuedEndpoints(event("user.created"), [a, b])).toEqual([
      { ...a, id: "t1.a" },
      { ...b, id: "t1.b" },
    ]);
  });

  test("reaches only the tested endpoint, whatever its types", () => {
    const all = [endpoint("a", ["user.created"]), endpoint("b")];
    const [only, ...rest] = queuedEndpoints(event(TEST_EVENT_TYPE, "a"), all);
    expect(rest).toEqual([]);
    expect(only?.id).toBe("t1.a");
    expect(only).not.toHaveProperty("types");
  });
});

describe("attemptRecordOf", () => {
  test("keeps what the receiver answered, with the endpoint's own id", () => {
    const attempt = {
      event: testEventOf("t1", "e1", new Date()),
      url: "https://secret.example/token",
      endpoint: "t1.e1",
      attempt: 2,
      status: 500,
      error: null,
      durationMs: 40,
      delivered: false,
      willRetry: true,
    };
    const record = attemptRecordOf(attempt);
    expect(record).toEqual({
      endpointId: "e1",
      eventId: attempt.event.id,
      type: TEST_EVENT_TYPE,
      attempt: 2,
      status: 500,
      error: null,
      durationMs: 40,
      delivered: false,
      willRetry: true,
    });
    expect(JSON.stringify(record)).not.toContain("secret.example");
  });
});

describe("testEventOf", () => {
  test("is a webhook.test event for one endpoint, with its own id", () => {
    const at = new Date("2026-11-22T10:00:00Z");
    const first = testEventOf("t1", "e1", at);
    expect(first).toMatchObject({
      type: TEST_EVENT_TYPE,
      occurredAt: at,
      data: { tenantId: "t1", endpointId: "e1" },
    });
    expect(testEventOf("t1", "e1", at).id).not.toBe(first.id);
  });
});
