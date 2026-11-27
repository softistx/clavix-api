import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { forTenant } from "@/config/users";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { defined } from "~/narrow";
import type { SocialEntry } from "./sign-in-methods.schema";
import { createSecretBox, secretContext } from "./sign-in-methods.secrets";
import {
  clearReplacedProfile,
  holdsSecret,
  type ReplacedSteps,
  sameValue,
  settleReplaced,
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

describe("settleReplaced", () => {
  const stepsOf = (calls: string[], failing: string[] = []): ReplacedSteps => {
    const step = (name: string) => async () => {
      calls.push(name);
      if (failing.includes(name)) throw new Error(`${name} down`);
    };
    return {
      revoke: step("revoke"),
      erase: step("erase"),
      clearProfile: step("profile"),
    };
  };

  test("the revocation runs first, then the erase, then the profile", async () => {
    const calls: string[] = [];
    await settleReplaced(stepsOf(calls), () => {});
    expect(calls).toEqual(["revoke", "erase", "profile"]);
  });

  test("a failed erase (its enqueue) is thrown after the revocation and the profile ran", async () => {
    const calls: string[] = [];
    await expect(
      settleReplaced(stepsOf(calls, ["erase"]), () => {}),
    ).rejects.toThrow("erase down");
    expect(calls).toEqual(["revoke", "erase", "profile"]);
  });

  test("a failed revocation still lets the erase and the profile run, then is thrown", async () => {
    const calls: string[] = [];
    await expect(
      settleReplaced(stepsOf(calls, ["revoke"]), () => {}),
    ).rejects.toThrow("revoke down");
    expect(calls).toEqual(["revoke", "erase", "profile"]);
  });

  test("the first failure is the one thrown", async () => {
    const calls: string[] = [];
    await expect(
      settleReplaced(stepsOf(calls, ["revoke", "erase"]), () => {}),
    ).rejects.toThrow("revoke down");
  });

  test("the profile clearing is best effort: reported, never thrown", async () => {
    const calls: string[] = [];
    const reported: unknown[] = [];
    await settleReplaced(stepsOf(calls, ["profile"]), (_, cause) =>
      reported.push(cause),
    );
    expect(calls).toEqual(["revoke", "erase", "profile"]);
    expect(reported).toHaveLength(1);
  });
});

describe("clearReplacedProfile", () => {
  let auth: Awaited<ReturnType<typeof forTenant>>;
  beforeAll(async () => {
    await tenantsService.create({ slug: "crp-t", name: "T" });
    const resolved = defined(
      await tenantResolver.resolveHost(`crp-t.${env.CLAVIX_DOMAIN}`),
    );
    auth = await forTenant(resolved);
  });
  afterAll(async () => {
    await mongo.db.tenants.raw.deleteMany({
      slug: { $ne: PLATFORM_TENANT_SLUG },
    });
  });

  test("clears the names, phone, birthdate and address, and keeps the name and email", async () => {
    const created = await defined(auth).create({
      email: "holder@crp.test",
      name: "Holder",
    });
    await defined(auth).update(
      created,
      {
        givenName: "Ada",
        familyName: "Lovelace",
        nickname: "ada",
        phone: { number: "+14155550100", verified: true },
        birthdate: "1815-12-10",
        address: { locality: "London" },
      },
      { ifVersion: created.version },
    );
    await clearReplacedProfile(defined(auth), created.id);
    const user = defined(await defined(auth).findUser(created.id));
    expect(user.givenName ?? null).toBeNull();
    expect(user.familyName ?? null).toBeNull();
    expect(user.nickname ?? null).toBeNull();
    expect(user.phone ?? null).toBeNull();
    expect(user.birthdate ?? null).toBeNull();
    expect(user.address ?? null).toBeNull();
    expect(user.name).toBe("Holder");
    expect(user.email).toBe("holder@crp.test");
  });

  test("a user with nothing set, or gone, writes nothing and does not fail", async () => {
    const created = await defined(auth).create({
      email: "empty@crp.test",
      name: "Empty",
    });
    await clearReplacedProfile(defined(auth), created.id);
    await clearReplacedProfile(defined(auth), "no-such-user");
    const user = defined(await defined(auth).findUser(created.id));
    expect(user.version).toBe(created.version);
  });
});
