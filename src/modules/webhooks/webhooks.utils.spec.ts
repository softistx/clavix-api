import { describe, expect, test } from "bun:test";
import { endpointDoc, sealedUnder } from "~/webhook-docs";
import type { EndpointSecret } from "./webhooks.model";
import type { AttemptRecord } from "./webhooks.types";
import {
  attemptDoc,
  behindCount,
  contextOf,
  deliveryEndpointOf,
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
