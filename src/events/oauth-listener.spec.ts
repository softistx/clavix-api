import { describe, expect, test } from "bun:test";
import type { OAuthEvent, OAuthEventType } from "@softistx/janus-oauth";
import type { EventBus } from "./bus";
import { oauthListener } from "./oauth-listener";
import type { AuthEvent, ClavixEvent } from "./types";

const TENANT = "b".repeat(24);
const ISSUER = "https://acme.clavix.test";
const at = new Date("2026-11-01T10:00:00Z");

const event = (
  type: OAuthEventType,
  data: Record<string, unknown> = {},
  more: Record<string, unknown> = {},
): OAuthEvent => ({
  id: "0193-event",
  type,
  occurredAt: at,
  issuer: ISSUER,
  clientId: "c1",
  userId: "u1",
  data,
  ...more,
});

async function run(e: OAuthEvent, tenant = TENANT) {
  const emitted: ClavixEvent[] = [];
  const bus: Pick<EventBus, "emit"> = {
    emit: async (x) => {
      emitted.push(x);
    },
  };
  await oauthListener(tenant, ISSUER, bus)(e);
  return emitted;
}

describe("oauthListener", () => {
  const cases: [
    OAuthEventType,
    Record<string, unknown>,
    Pick<AuthEvent, "type" | "outcome" | "reason">,
  ][] = [
    [
      "oauth.grant.created",
      { via: "device", grantId: "g" },
      { type: "consent.granted", outcome: "success", reason: "device" },
    ],
    [
      "oauth.request.denied",
      { resource: "r" },
      { type: "consent.denied", outcome: "failure", reason: "denied" },
    ],
    [
      "oauth.grant.revoked",
      { reason: "user", grantId: "g" },
      { type: "grant.revoked", outcome: "success", reason: "user" },
    ],
    [
      "oauth.refresh.reused",
      { grantId: "g" },
      { type: "refreshToken.reused", outcome: "failure", reason: "reused" },
    ],
    [
      "oauth.device.decided",
      { decision: "approved" },
      { type: "device.approved", outcome: "success", reason: "approved" },
    ],
    [
      "oauth.device.decided",
      { decision: "denied" },
      { type: "device.denied", outcome: "failure", reason: "denied" },
    ],
    [
      "oauth.token.exchanged",
      { mode: "delegation" },
      { type: "token.exchanged", outcome: "success", reason: "delegation" },
    ],
    [
      "oauth.client.registered",
      { via: "dynamic", name: "Evil <b>" },
      { type: "client.registered", outcome: "success", reason: "dynamic" },
    ],
  ];

  for (const [type, data, expected] of cases) {
    test(`${type} ${JSON.stringify(data)} is recorded with its client and user`, async () => {
      expect(await run(event(type, data))).toEqual([
        {
          kind: "auth",
          tenantId: TENANT,
          ...expected,
          userId: "u1",
          clientId: "c1",
          requestId: "0193-event",
          at,
        },
      ]);
    });
  }

  test("a client that failed to log in is not recorded", async () => {
    expect(
      await run(event("oauth.client.loginFailed", { reason: "wrong_secret" })),
    ).toEqual([]);
  });

  test("an event of another issuer never writes into this tenant's log", async () => {
    expect(
      await run(
        event("oauth.grant.created", {}, { issuer: "https://other.test" }),
      ),
    ).toEqual([]);
  });

  test("an event without a user keeps its client only", async () => {
    const [e] = await run(
      event(
        "oauth.grant.revoked",
        { reason: "client", count: 3 },
        {
          userId: undefined,
        },
      ),
    );
    expect(e).not.toHaveProperty("userId");
    expect(e).toMatchObject({ clientId: "c1", reason: "client" });
  });
});
