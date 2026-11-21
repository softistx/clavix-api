import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { SocialEntry } from "./sign-in-methods.schema";
import { createSecretBox, secretContext } from "./sign-in-methods.secrets";
import {
  holdsSecret,
  sameValue,
  storedOf,
  withSocial,
} from "./sign-in-methods.utils";

const box = createSecretBox(randomBytes(32));
const OWNER = "65f0000000000000000000aa";
const entryOf = (provider: SocialEntry["provider"], secret: string) => ({
  provider,
  clientId: `${provider}-id`,
  secret: box.seal(secret, secretContext(OWNER, provider)),
  enabled: true,
});

describe("sameValue", () => {
  test("equal plain data is the same, a different value is not", () => {
    expect(sameValue({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
  });
});

describe("holdsSecret", () => {
  test("the stored secret is held, another is not", () => {
    const current = entryOf("google", "s3cret");
    expect(holdsSecret(box, OWNER, current, "s3cret")).toBe(true);
    expect(holdsSecret(box, OWNER, current, "other")).toBe(false);
  });

  test("no stored entry holds nothing", () => {
    expect(holdsSecret(box, OWNER, undefined, "s3cret")).toBe(false);
  });

  test("a secret sealed for another tenant, or under another key, holds nothing", () => {
    const current = entryOf("google", "s3cret");
    expect(
      holdsSecret(box, "65f0000000000000000000bb", current, "s3cret"),
    ).toBe(false);
    expect(
      holdsSecret(createSecretBox(randomBytes(32)), OWNER, current, "s3cret"),
    ).toBe(false);
  });
});

describe("withSocial", () => {
  test("it replaces the provider's entry and orders the entries by provider", () => {
    const github = entryOf("github", "a");
    const google = entryOf("google", "b");
    const next = { ...google, clientId: "new" };
    expect(withSocial([google, github], next)).toEqual([github, next]);
  });

  test("it adds an entry for a new provider and leaves the input alone", () => {
    const google = entryOf("google", "b");
    const input = [google];
    const microsoft = entryOf("microsoft", "c");
    expect(withSocial(input, microsoft)).toEqual([google, microsoft]);
    expect(input).toEqual([google]);
  });
});

describe("storedOf", () => {
  const names = { emailCode: "EMAIL_CODE", passkey: "PASSKEY" } as const;

  test("finds the stored name of an enum value", () => {
    expect(storedOf(names, "PASSKEY")).toBe("passkey");
    expect(storedOf(names, "EMAIL_CODE")).toBe("emailCode");
  });

  test("an enum value the map lacks fails loudly", () => {
    expect(() => storedOf<string, string>(names, "SMS")).toThrow(
      'No stored name for the enum value "SMS"',
    );
  });
});
