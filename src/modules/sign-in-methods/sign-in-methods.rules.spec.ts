import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { GraphQLError } from "graphql";
import {
  checkedSocial,
  checkedValue,
  MAX_VALUE_LENGTH,
  methodChange,
  nextMfa,
  requireFirstParty,
  requireUsable,
  resealEntries,
  withMethods,
} from "./sign-in-methods.rules";
import {
  type SignInPolicy,
  signInPolicySchema,
} from "./sign-in-methods.schema";
import {
  createSecretBox,
  emptySecretResealCounts,
  secretContext,
} from "./sign-in-methods.secrets";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as GraphQLError).extensions["code"];
  }
  return undefined;
};
const policy = (patch: Partial<SignInPolicy> = {}): SignInPolicy => ({
  ...signInPolicySchema.parse(undefined),
  ...patch,
});
const off = (...types: SignInPolicy["methods"][number]["type"][]) =>
  types.map((type) => ({ type, enabled: false }));

describe("checkedValue", () => {
  test("it trims, and keeps 1 to 512 characters", () => {
    expect(checkedValue("clientId", "  abc  ")).toBe("abc");
    expect(checkedValue("clientId", "x".repeat(MAX_VALUE_LENGTH))).toHaveLength(
      MAX_VALUE_LENGTH,
    );
  });

  test("blank or too long is BAD_USER_INPUT naming the field", () => {
    expect(code(() => checkedValue("clientId", "   "))).toBe("BAD_USER_INPUT");
    expect(
      code(() => checkedValue("clientId", "x".repeat(MAX_VALUE_LENGTH + 1))),
    ).toBe("BAD_USER_INPUT");
    expect(() => checkedValue("clientSecret", "")).toThrow(
      "clientSecret must be 1 to 512 characters",
    );
  });
});

describe("checkedSocial", () => {
  test("a value left out stays undefined, a given one is trimmed", () => {
    expect(checkedSocial({ provider: "google" })).toEqual({
      clientId: undefined,
      clientSecret: undefined,
    });
    expect(
      checkedSocial({
        provider: "google",
        clientId: " id ",
        clientSecret: " s ",
      }),
    ).toEqual({ clientId: "id", clientSecret: "s" });
  });
});

describe("methodChange", () => {
  test("it maps each type to its state", () => {
    const change = methodChange([
      { type: "passkey", enabled: false },
      { type: "magicLink", enabled: true },
    ]);
    expect(change.get("passkey")).toBe(false);
    expect(change.get("magicLink")).toBe(true);
  });

  test("a type given twice is BAD_USER_INPUT", () => {
    expect(
      code(() =>
        methodChange([
          { type: "passkey", enabled: true },
          { type: "passkey", enabled: false },
        ]),
      ),
    ).toBe("BAD_USER_INPUT");
  });

  test("turning on a method that is not available is SIGN_IN_METHOD_UNAVAILABLE, turning it off is fine", () => {
    expect(
      code(() => methodChange([{ type: "password", enabled: true }])),
    ).toBe("SIGN_IN_METHOD_UNAVAILABLE");
    expect(() =>
      methodChange([{ type: "password", enabled: false }]),
    ).not.toThrow();
  });
});

describe("withMethods", () => {
  test("a type with no entry keeps its value", () => {
    const methods = withMethods(policy(), new Map([["passkey", false]]));
    expect(methods.find((m) => m.type === "passkey")?.enabled).toBe(false);
    expect(methods.find((m) => m.type === "emailCode")?.enabled).toBe(true);
  });
});

describe("nextMfa", () => {
  test("a field left out keeps its value", () => {
    const current = { mode: "passkeySufficient", totp: false } as const;
    expect(nextMfa(current, { totp: true })).toEqual({
      mode: "passkeySufficient",
      totp: true,
    });
    expect(nextMfa(current, { mode: "required" })).toEqual({
      mode: "required",
      totp: false,
    });
    expect(nextMfa(current, {})).toEqual(current);
  });
});

describe("requireFirstParty", () => {
  test("passkey or e-mail code on is enough", () => {
    expect(() => requireFirstParty(policy())).not.toThrow();
    expect(() =>
      requireFirstParty(policy({ methods: off("passkey") })),
    ).not.toThrow();
  });

  test("with both off it is PLATFORM_FIRST_PARTY_METHOD (409)", () => {
    expect(
      code(() =>
        requireFirstParty(policy({ methods: off("passkey", "emailCode") })),
      ),
    ).toBe("PLATFORM_FIRST_PARTY_METHOD");
  });
});

describe("requireUsable", () => {
  test("it answers the policy while a method is on", () => {
    const current = policy();
    expect(requireUsable(current)).toBe(current);
  });

  test("with every method off and no social app it is NO_SIGN_IN_METHOD (409)", () => {
    const methods = off("passkey", "emailCode", "magicLink", "password");
    expect(code(() => requireUsable(policy({ methods })))).toBe(
      "NO_SIGN_IN_METHOD",
    );
  });
});

describe("resealEntries", () => {
  const OWNER = "65f0000000000000000000aa";
  const old = createSecretBox(randomBytes(32));
  const key = randomBytes(32);
  const second = randomBytes(32);
  const box = createSecretBox([key, second]);
  const entry = (sealer: typeof box, provider: "google" | "github") => ({
    provider,
    clientId: `${provider}-id`,
    secret: sealer.seal("s", secretContext(OWNER, provider)),
    enabled: true,
  });

  test("an entry under the first key is current, one under an older key is sealed again", () => {
    const older = createSecretBox(second);
    const social = [entry(box, "google"), entry(older, "github")];
    const counts = emptySecretResealCounts();
    const logs: string[] = [];
    const out = resealEntries(OWNER, social, box, (m) => logs.push(m), counts);
    expect(out.pending).toBe(1);
    expect(counts).toMatchObject({ scanned: 2, current: 1, unreadable: 0 });
    expect(out.social[0]).toBe(social[0] as never);
    expect(out.social[1]?.secret.kid).toBe(box.kid);
    expect(logs).toEqual([]);
  });

  test("a secret no key opens is left as it is, counted and logged by provider and tenant", () => {
    const social = [entry(old, "github")];
    const counts = emptySecretResealCounts();
    const logs: string[] = [];
    const out = resealEntries(OWNER, social, box, (m) => logs.push(m), counts);
    expect(out.pending).toBe(0);
    expect(out.social[0]).toBe(social[0] as never);
    expect(counts.unreadable).toBe(1);
    expect(logs).toEqual([
      `sign-in: the github secret of tenant ${OWNER} could not be sealed again`,
    ]);
  });
});
