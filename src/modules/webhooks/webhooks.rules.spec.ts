import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { WebhookError } from "./webhooks.errors";
import type { EndpointSecret } from "./webhooks.model";
import {
  descriptionOf,
  endpointChanges,
  isLive,
  MAX_SECRETS,
  ROLL_OVERLAP_MS,
  rolledSecrets,
  typesOf,
} from "./webhooks.rules";
import type { WebhookEndpointDoc } from "./webhooks.types";

const NOW = new Date("2026-11-18T12:00:00Z");
const secret = (sid: string, expiresAt: Date | null): EndpointSecret => ({
  sid,
  sealed: { kid: "k", iv: "i", ct: sid, tag: "t" } as never,
  createdAt: NOW,
  expiresAt,
});
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof WebhookError) return `${error.code}:${error.field}`;
  }
  return "none";
};
const endpoint = (patch: Partial<WebhookEndpointDoc> = {}) =>
  ({
    _id: new ObjectId(),
    url: "https://hooks.example.com/in",
    enabled: true,
    ...patch,
  }) as WebhookEndpointDoc;

describe("typesOf", () => {
  test("keeps each type once and nothing when none is given", () => {
    expect(typesOf(["user.created", "user.created"])).toEqual(["user.created"]);
    expect(typesOf(undefined)).toEqual([]);
  });

  test("refuses an unknown type on `types`", () => {
    expect(refusal(() => typesOf(["nope"]))).toBe("BAD_USER_INPUT:types");
  });
});

describe("descriptionOf", () => {
  test("trims, leaves undefined alone and caps at 200 characters", () => {
    expect(descriptionOf("  hi ")).toBe("hi");
    expect(descriptionOf(undefined)).toBeUndefined();
    expect(descriptionOf("x".repeat(200))).toHaveLength(200);
    expect(refusal(() => descriptionOf("x".repeat(201)))).toBe(
      "BAD_USER_INPUT:description",
    );
  });
});

describe("endpointChanges", () => {
  test("writes nothing for an unchanged patch", () => {
    const current = endpoint();
    expect(
      endpointChanges(current, { url: current.url, enabled: true }),
    ).toEqual({});
  });

  test("normalises a new address", () => {
    expect(
      endpointChanges(endpoint(), { url: "https://New.example.com" }).url,
    ).toBe("https://new.example.com/");
  });

  test("switching off is manual, switching on clears the give-ups (D20)", () => {
    expect(endpointChanges(endpoint(), { enabled: false })).toEqual({
      enabled: false,
      disabledReason: "manual",
    });
    expect(
      endpointChanges(endpoint({ enabled: false }), { enabled: true }),
    ).toEqual({
      enabled: true,
      disabledReason: null,
      consecutiveGiveUps: 0,
    });
  });
});

describe("rolledSecrets", () => {
  const fresh = secret("new", null);

  test("without keepPrevious only the new secret stays", () => {
    expect(rolledSecrets(fresh, [secret("old", null)], false, NOW)).toEqual([
      fresh,
    ]);
  });

  test("keeps the live ones, capped at 24 hours, and drops the expired", () => {
    const until = new Date(NOW.getTime() + ROLL_OVERLAP_MS);
    const rolled = rolledSecrets(
      fresh,
      [
        secret("cur", null),
        secret("gone", new Date(NOW.getTime() - 1)),
        secret("soon", new Date(NOW.getTime() + 1000)),
      ],
      true,
      NOW,
    );
    expect(rolled.map((entry) => entry.sid)).toEqual(["new", "cur", "soon"]);
    expect(rolled[1]?.expiresAt).toEqual(until);
    expect(rolled[2]?.expiresAt).toEqual(new Date(NOW.getTime() + 1000));
  });

  test("never passes MAX_SECRETS", () => {
    const many = [1, 2, 3, 4].map((n) => secret(`s${n}`, null));
    expect(rolledSecrets(fresh, many, true, NOW)).toHaveLength(MAX_SECRETS);
  });
});

describe("isLive", () => {
  test("a secret signs until its expiry", () => {
    expect(isLive(secret("a", null), NOW)).toBe(true);
    expect(isLive(secret("a", new Date(NOW.getTime() + 1)), NOW)).toBe(true);
    expect(isLive(secret("a", NOW), NOW)).toBe(false);
  });
});
