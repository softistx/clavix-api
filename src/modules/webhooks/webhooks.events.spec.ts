import { describe, expect, test } from "bun:test";
import type { UserEvent } from "@softistx/janus";
import type { AuthEvent } from "@/events/types";
import {
  isWebhookEventType,
  signedInWebhookEvent,
  userWebhookEvent,
  WEBHOOK_EVENT_TYPES,
} from "./webhooks.events";

const TENANT = "a".repeat(24);
const signIn = (patch: Partial<AuthEvent> = {}): AuthEvent => ({
  kind: "auth",
  tenantId: TENANT,
  type: "session.signIn",
  outcome: "success",
  userId: "u1",
  ip: "203.0.113.9",
  ...patch,
});

describe("catalogue", () => {
  test("is the 16 user events and session.signedIn", () => {
    expect(WEBHOOK_EVENT_TYPES).toHaveLength(17);
    expect(isWebhookEventType("user.created")).toBe(true);
    expect(isWebhookEventType("session.signedIn")).toBe(true);
    expect(isWebhookEventType("domain.add")).toBe(false);
    expect(isWebhookEventType("user.apiKeyCreated")).toBe(false);
    expect(isWebhookEventType("user.apiKeyRevoked")).toBe(false);
    // No password flow runs while password sign-in is unavailable (#336).
    expect(isWebhookEventType("user.passwordReset")).toBe(false);
    expect(isWebhookEventType("user.passwordChanged")).toBe(false);
  });
});

describe("userWebhookEvent", () => {
  test("carries ids only", () => {
    // A janus event never carries an address or an e-mail; a stray one must not leak.
    const stray = { email: "a@b.c", ip: "203.0.113.9" };
    const janusEvent: UserEvent = {
      id: "e1",
      type: "user.socialLinked",
      userId: "u1",
      userType: "customer",
      provider: "google",
      occurredAt: new Date(),
      ...stray,
    };
    const event = userWebhookEvent(TENANT, janusEvent);
    expect(event.data).toEqual({
      tenantId: TENANT,
      userId: "u1",
      userType: "customer",
      provider: "google",
    });
    expect(JSON.stringify(event)).not.toContain("203.0.113.9");
    expect(JSON.stringify(event)).not.toContain("a@b.c");
  });
});

describe("signedInWebhookEvent", () => {
  test("a successful sign-in, without the address", () => {
    const event = signedInWebhookEvent(signIn(), () => new Date());
    expect(event?.type).toBe("session.signedIn");
    expect(event?.data).toEqual({ tenantId: TENANT, userId: "u1" });
  });
  test("failures, other types and unknown users are not delivered", () => {
    expect(
      signedInWebhookEvent(signIn({ outcome: "failure" }), () => new Date()),
    ).toBeUndefined();
    expect(
      signedInWebhookEvent(signIn({ userId: undefined }), () => new Date()),
    ).toBeUndefined();
    expect(
      signedInWebhookEvent(
        signIn({ type: "session.signOut" }),
        () => new Date(),
      ),
    ).toBeUndefined();
  });
});
