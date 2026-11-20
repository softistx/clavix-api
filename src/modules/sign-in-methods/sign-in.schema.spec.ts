import { expect, test } from "bun:test";
import {
  hasSignInMethod,
  isEnabled,
  methodsOf,
  signInPolicySchema,
} from "./sign-in.schema";

test("a tenant stored before the policy reads the defaults: passkey and e-mail code on, magic link and password off", () => {
  const policy = signInPolicySchema.parse(undefined);
  expect(methodsOf(policy)).toEqual([
    { type: "passkey", enabled: true },
    { type: "emailCode", enabled: true },
    { type: "magicLink", enabled: false },
    { type: "password", enabled: false },
  ]);
  expect(policy.social).toEqual([]);
  expect(signInPolicySchema.parse({})).toEqual(policy);
});

test("a type with no entry reads its default, and the list keeps the fixed order", () => {
  const policy = signInPolicySchema.parse({
    methods: [
      { type: "magicLink", enabled: true },
      { type: "passkey", enabled: false },
    ],
  });
  expect(methodsOf(policy).map((m) => [m.type, m.enabled])).toEqual([
    ["passkey", false],
    ["emailCode", true],
    ["magicLink", true],
    ["password", false],
  ]);
});

test("password is never on while it is not available, even stored on", () => {
  const policy = signInPolicySchema.parse({
    methods: [
      { type: "password", enabled: true },
      { type: "passkey", enabled: false },
      { type: "emailCode", enabled: false },
    ],
  });
  expect(isEnabled(policy, "password")).toBe(false);
  expect(hasSignInMethod(policy)).toBe(false);
});

test("a policy stored before the mfa block reads its defaults", () => {
  const policy = signInPolicySchema.parse({ methods: [], social: [] });
  expect(policy.mfa).toEqual({ mode: "passkeySufficient", totp: false });
  expect(signInPolicySchema.parse(undefined).mfa).toEqual(policy.mfa);
});

test("an mfa block fills what it leaves out", () => {
  const policy = signInPolicySchema.parse({
    methods: [],
    social: [],
    mfa: { totp: true },
  });
  expect(policy.mfa).toEqual({ mode: "passkeySufficient", totp: true });
  expect(() =>
    signInPolicySchema.parse({ mfa: { mode: "sometimes" } }),
  ).toThrow();
});
