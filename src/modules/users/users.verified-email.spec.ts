import { describe, expect, test } from "bun:test";
import { emailUnverified, requireVerifiedEmail } from "./users.verified-email";

describe("requireVerifiedEmail", () => {
  test("lets a proved address through", () => {
    expect(() => requireVerifiedEmail({ emailVerified: true })).not.toThrow();
  });

  test("refuses an unproved one with EMAIL_UNVERIFIED (403)", () => {
    const refusal = emailUnverified();
    expect(() => requireVerifiedEmail({ emailVerified: false })).toThrow(
      refusal.message,
    );
  });
});
