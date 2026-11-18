import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { OptimisticLockError } from "@softistx/mongo";
import type { GraphQLError } from "graphql";
import { ObjectId } from "mongodb";
import { createApp } from "@/app";
import { access } from "@/config/access";
import { adminEventReader, adminEventRecorder } from "@/config/admin-events";
import { authEventsService } from "@/config/audit";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { secretBox } from "@/config/keys";
import { oauthDb } from "@/config/oauth-db";
import { domainStore, tenantResolver, tenantsService } from "@/config/tenancy";
import { janusIssuers } from "@/config/users";
import type { ConsoleAdmins, ConsoleUsers } from "@/console/context";
import { createExclusive } from "@/console/exclusive";
import { CONSOLE_CLIENT_ID } from "@/console/identity";
import { secretContext } from "@/modules/sign-in-methods/secrets";
import { SignInPolicyService } from "@/modules/sign-in-methods/service";
import { socialProvidersOf } from "@/modules/sign-in-methods/social";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { socialOf } from "@/users/tenant-janus";
import { CONSOLE_PATH } from "../../identity";
import { consoleSchema } from "../../schema";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const SECRET = "GOCSPX-spec-secret-do-not-leak";

interface Policy {
  tenantId: string;
  methods: { type: string; enabled: boolean; available: boolean }[];
  social: {
    provider: string;
    clientId: string;
    hasSecret: boolean;
    enabled: boolean;
    callbackUrl: string;
  }[];
  version: number;
}
interface Result {
  data?: Record<string, Policy> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
  text: string;
}

const as = async (
  userId: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Result> => {
  const response = await createApp({
    console: {
      authenticate: async () => ({
        userId,
        clientId: CONSOLE_CLIENT_ID,
        grantId: "g",
        scopes: ["console"],
        clientName: null,
        bound: null,
        jkt: null,
        authorizationDetails: [],
      }),
      access,
      adminEvents: adminEventRecorder,
      activity: { admin: adminEventReader, auth: authEventsService },
      admins: {} as ConsoleAdmins,
      users: {} as ConsoleUsers,
      exclusive: createExclusive(),
      directory: {
        findUser: async () => null,
        emailVerified: async () => true,
        findUserByEmail: async () => null,
        tenantsByIds: async () => [],
      },
    },
  }).request(`http://localhost${CONSOLE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer x",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  return { ...(JSON.parse(text) as Omit<Result, "text">), text };
};
const codeOf = (result: Result) => result.errors?.[0]?.extensions?.code;

const FIELDS =
  "tenantId version methods { type enabled available } social { provider clientId hasSecret enabled callbackUrl }";
const POLICY = `query ($t: ID!) { signInPolicy(tenantId: $t) { ${FIELDS} } }`;
const METHODS = `mutation ($t: ID!, $m: [SignInMethodInput!]!) {
  updateSignInMethods(tenantId: $t, methods: $m) { ${FIELDS} }
}`;
const SET = `mutation ($t: ID!, $i: SocialProviderInput!) {
  setSocialProvider(tenantId: $t, input: $i) { ${FIELDS} }
}`;
const REMOVE = `mutation ($t: ID!, $p: SocialProviderKind!) {
  removeSocialProvider(tenantId: $t, provider: $p) { ${FIELDS} }
}`;

const OWNER_A = "sim-owner-a";
const ADMIN_A = "sim-admin-a";
const VIEWER_A = "sim-viewer-a";
const ADMIN_B = "sim-admin-b";
const ADMIN_C = "sim-admin-c";
const ADMIN_PLATFORM = "sim-admin-platform";
let a = "";
let b = "";
let c = "";

const stored = async (id: string) => {
  const [tenant] = await tenantsService.activeByIds([id]);
  if (tenant === undefined) throw new Error("no tenant");
  return tenant;
};
const platformTenant = async () => {
  const tenant = await mongo.db.tenants.raw.findOne({
    slug: PLATFORM_TENANT_SLUG,
  });
  if (tenant === null) throw new Error("no platform tenant");
  return tenant;
};
const policyOf = async (user: string, tenantId: string) => {
  const result = await as(user, POLICY, { t: tenantId });
  const policy = result.data?.["signInPolicy"];
  if (policy === undefined) throw new Error(result.text);
  return policy;
};
const enabledOf = (policy: Policy) =>
  policy.methods.filter((m) => m.enabled).map((m) => m.type);

beforeAll(async () => {
  a = (await tenantsService.create({ slug: "sim-a", name: "A" })).id;
  b = (await tenantsService.create({ slug: "sim-b", name: "B" })).id;
  await access.grantTenant(a, OWNER_A, "owner");
  await access.grantTenant(a, ADMIN_A, "admin");
  await access.grantTenant(a, VIEWER_A, "viewer");
  await access.grantTenant(b, ADMIN_B, "admin");
  c = (await tenantsService.create({ slug: "sim-c", name: "C" })).id;
  await access.grantTenant(c, ADMIN_C, "admin");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $nin: [PLATFORM_TENANT_SLUG] },
  });
  await oauthDb.collection("relations").deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
});

const eventsOf = async (tenantId: string) =>
  (
    await mongo.db.adminEvents.raw
      .find({ tenantId: new ObjectId(tenantId) })
      .sort({ _id: 1 })
      .toArray()
  ).map((event) => ({
    actor: event["actor"],
    action: event["action"],
    target: event["target"],
  }));

describe("the contract", () => {
  test("no type of the console schema can return a secret", () => {
    const type = consoleSchema.getType("SocialProviderConfig");
    const fields = Object.keys(
      (type as { getFields(): Record<string, unknown> }).getFields(),
    );
    expect(fields.sort()).toEqual([
      "callbackUrl",
      "clientId",
      "enabled",
      "hasSecret",
      "provider",
    ]);
    expect(Object.keys(consoleSchema.getTypeMap()).join(" ")).not.toMatch(
      /sealed/i,
    );
  });
});

describe("permissions", () => {
  test("an upper-case tenant id reads the same policy", async () => {
    expect(await policyOf(VIEWER_A, a.toUpperCase())).toEqual(
      await policyOf(VIEWER_A, a),
    );
  });

  test("a viewer reads the policy and cannot change it", async () => {
    expect(enabledOf(await policyOf(VIEWER_A, a))).toEqual([
      "PASSKEY",
      "EMAIL_CODE",
    ]);
    const before = (await stored(a)).version;
    for (const [query, variables] of [
      [METHODS, { t: a, m: [{ type: "MAGIC_LINK", enabled: true }] }],
      [
        SET,
        { t: a, i: { provider: "GOOGLE", clientId: "x", clientSecret: "y" } },
      ],
      [REMOVE, { t: a, p: "GOOGLE" }],
    ] as const) {
      expect(codeOf(await as(VIEWER_A, query, variables))).toBe("FORBIDDEN");
    }
    expect((await stored(a)).version).toBe(before);
  });

  test("tenant A's admin and owner cannot read or change tenant B", async () => {
    const before = (await stored(b)).version;
    for (const user of [ADMIN_A, OWNER_A]) {
      expect(codeOf(await as(user, POLICY, { t: b }))).toBe("FORBIDDEN");
      expect(
        codeOf(
          await as(user, METHODS, {
            t: b,
            m: [{ type: "MAGIC_LINK", enabled: true }],
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(
        codeOf(
          await as(user, SET, {
            t: b,
            i: { provider: "GOOGLE", clientId: "x", clientSecret: "y" },
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(codeOf(await as(user, REMOVE, { t: b, p: "GOOGLE" }))).toBe(
        "FORBIDDEN",
      );
    }
    expect((await stored(b)).version).toBe(before);
  });

  test("a caller with no role, and a tenant that does not exist, are refused", async () => {
    expect(codeOf(await as("sim-nobody", POLICY, { t: a }))).toBe("FORBIDDEN");
    expect(
      codeOf(await as(ADMIN_A, POLICY, { t: "65f0000000000000000000aa" })),
    ).toBe("FORBIDDEN");
  });
});

describe("the methods", () => {
  test("the defaults list every type, password unavailable", async () => {
    expect((await policyOf(ADMIN_B, b)).methods).toEqual([
      { type: "PASSKEY", enabled: true, available: true },
      { type: "EMAIL_CODE", enabled: true, available: true },
      { type: "MAGIC_LINK", enabled: false, available: true },
      { type: "PASSWORD", enabled: false, available: false },
    ]);
  });

  test("an admin turns magic link on; the version rises and the tenant's janus follows", async () => {
    const before = await stored(a);
    const result = await as(ADMIN_A, METHODS, {
      t: a,
      m: [{ type: "MAGIC_LINK", enabled: true }],
    });
    const policy = result.data?.["updateSignInMethods"];
    expect(policy === undefined ? [] : enabledOf(policy)).toEqual([
      "PASSKEY",
      "EMAIL_CODE",
      "MAGIC_LINK",
    ]);
    expect(policy?.version).toBeGreaterThan(before.version);
    // The stored policy is a list of entries.
    expect((await stored(a)).signIn.methods).toContainEqual({
      type: "magicLink",
      enabled: true,
    });
    const host = new URL(issuerOf("sim-a", origin)).host;
    const resolved = await tenantResolver.resolveHost(host);
    expect(resolved?.version).toBe(policy?.version ?? -1);
    expect(resolved?.signIn.methods).toContainEqual({
      type: "magicLink",
      enabled: true,
    });
    const janus = await janusIssuers.forRequest(
      new Request(issuerOf("sim-a", origin)),
    );
    expect(janus?.magicLink.enabled).toBe(true);
    // Tenant B is untouched.
    expect(enabledOf(await policyOf(ADMIN_B, b))).toEqual([
      "PASSKEY",
      "EMAIL_CODE",
    ]);
  });

  test("the same change again writes nothing (idempotent)", async () => {
    const before = (await stored(a)).version;
    const result = await as(ADMIN_A, METHODS, {
      t: a,
      m: [{ type: "MAGIC_LINK", enabled: true }],
    });
    expect(result.data?.["updateSignInMethods"]?.version).toBe(before);
    expect((await stored(a)).version).toBe(before);
  });

  test("the last method cannot be turned off: NO_SIGN_IN_METHOD", async () => {
    const before = await stored(b);
    const result = await as(ADMIN_B, METHODS, {
      t: b,
      m: [
        { type: "PASSKEY", enabled: false },
        { type: "EMAIL_CODE", enabled: false },
      ],
    });
    expect(codeOf(result)).toBe("NO_SIGN_IN_METHOD");
    expect((await stored(b)).version).toBe(before.version);
    expect(enabledOf(await policyOf(ADMIN_B, b))).toEqual([
      "PASSKEY",
      "EMAIL_CODE",
    ]);
  });

  test("the platform tenant keeps a first-party method: PLATFORM_FIRST_PARTY_METHOD", async () => {
    const platform = (await platformTenant())._id.toHexString();
    await access.grantTenant(platform, ADMIN_PLATFORM, "admin");
    const before = await stored(platform);
    // Social providers do not count for the platform tenant.
    const refused = await as(ADMIN_PLATFORM, METHODS, {
      t: platform,
      m: [
        { type: "PASSKEY", enabled: false },
        { type: "EMAIL_CODE", enabled: false },
      ],
    });
    expect(codeOf(refused)).toBe("PLATFORM_FIRST_PARTY_METHOD");
    expect((await stored(platform)).version).toBe(before.version);
    // One first-party method left is enough; the same change again writes nothing.
    const one = [{ type: "PASSKEY", enabled: false }];
    const first = await as(ADMIN_PLATFORM, METHODS, { t: platform, m: one });
    expect(first.errors).toBeUndefined();
    const version = (await stored(platform)).version;
    const again = await as(ADMIN_PLATFORM, METHODS, { t: platform, m: one });
    expect(again.data?.["updateSignInMethods"]?.version).toBe(version);
    expect((await stored(platform)).version).toBe(version);
    // Turning the last one off is refused, magic link on or not.
    const last = await as(ADMIN_PLATFORM, METHODS, {
      t: platform,
      m: [
        { type: "MAGIC_LINK", enabled: true },
        { type: "EMAIL_CODE", enabled: false },
      ],
    });
    expect(codeOf(last)).toBe("PLATFORM_FIRST_PARTY_METHOD");
    await as(ADMIN_PLATFORM, METHODS, {
      t: platform,
      m: [{ type: "PASSKEY", enabled: true }],
    });
  });

  test("another tenant may keep only a social provider", async () => {
    const set = await as(ADMIN_C, SET, {
      t: c,
      i: { provider: "GITHUB", clientId: "id", clientSecret: SECRET },
    });
    expect(set.errors).toBeUndefined();
    const result = await as(ADMIN_C, METHODS, {
      t: c,
      m: [
        { type: "PASSKEY", enabled: false },
        { type: "EMAIL_CODE", enabled: false },
      ],
    });
    expect(result.errors).toBeUndefined();
    expect(enabledOf(result.data?.["updateSignInMethods"] as Policy)).toEqual(
      [],
    );
    await as(ADMIN_C, METHODS, {
      t: c,
      m: [
        { type: "PASSKEY", enabled: true },
        { type: "EMAIL_CODE", enabled: true },
      ],
    });
    await as(ADMIN_C, REMOVE, { t: c, p: "GITHUB" });
  });

  test("password cannot be turned on yet: SIGN_IN_METHOD_UNAVAILABLE", async () => {
    const result = await as(ADMIN_B, METHODS, {
      t: b,
      m: [{ type: "PASSWORD", enabled: true }],
    });
    expect(codeOf(result)).toBe("SIGN_IN_METHOD_UNAVAILABLE");
    // Off is what it already is: no change, no refusal.
    const off = await as(ADMIN_B, METHODS, {
      t: b,
      m: [{ type: "PASSWORD", enabled: false }],
    });
    expect(off.errors).toBeUndefined();
  });

  test("a type given twice is BAD_USER_INPUT", async () => {
    const result = await as(ADMIN_B, METHODS, {
      t: b,
      m: [
        { type: "PASSKEY", enabled: true },
        { type: "PASSKEY", enabled: false },
      ],
    });
    expect(codeOf(result)).toBe("BAD_USER_INPUT");
  });
});

describe("the social providers", () => {
  test("a new provider needs its client id and its secret", async () => {
    expect(
      codeOf(
        await as(ADMIN_A, SET, {
          t: a,
          i: { provider: "GOOGLE", clientId: "id" },
        }),
      ),
    ).toBe("SOCIAL_SECRET_REQUIRED");
    expect(
      codeOf(
        await as(ADMIN_A, SET, {
          t: a,
          i: { provider: "GOOGLE", clientSecret: SECRET },
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      codeOf(
        await as(ADMIN_A, SET, {
          t: a,
          i: { provider: "GOOGLE", clientId: " ", clientSecret: SECRET },
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect((await stored(a)).signIn.social).toEqual([]);
  });

  test("a clientSecret of the wrong type is refused without quoting it back", async () => {
    const leaked = "GOCSPX-typed-wrong-do-not-quote";
    for (const clientSecret of [{ value: leaked }, [leaked], 123456789]) {
      const result = await as(ADMIN_A, SET, {
        t: a,
        i: { provider: "GOOGLE", clientId: "id", clientSecret },
      });
      expect(result.errors).toBeDefined();
      expect(result.text).not.toContain(leaked);
      expect(result.text).not.toContain("123456789");
    }
    expect((await stored(a)).signIn.social).toEqual([]);
  });

  test("the secret is sealed at rest in the envelope and never returned", async () => {
    const warn = spyOn(console, "warn");
    const log = spyOn(console, "log");
    const result = await as(ADMIN_A, SET, {
      t: a,
      i: { provider: "GOOGLE", clientId: "google-id", clientSecret: SECRET },
    });
    expect(result.text).not.toContain(SECRET);
    expect(result.data?.["setSocialProvider"]?.social).toEqual([
      {
        provider: "GOOGLE",
        clientId: "google-id",
        hasSecret: true,
        enabled: true,
        callbackUrl: `${issuerOf("sim-a", origin)}/sign-in/social/google/callback`,
      },
    ]);
    expect((await as(VIEWER_A, POLICY, { t: a })).text).not.toContain(SECRET);

    const raw = await mongo.db.tenants.raw.findOne({ slug: "sim-a" });
    expect(JSON.stringify(raw)).not.toContain(SECRET);
    const [entry] = (await stored(a)).signIn.social;
    expect(Object.keys(entry?.secret ?? {}).sort()).toEqual([
      "ct",
      "iv",
      "kid",
      "v",
    ]);
    expect(entry?.secret).toMatchObject({ v: 1, kid: secretBox.kid });
    if (entry === undefined) throw new Error("no entry");
    expect(secretBox.open(entry.secret, secretContext(a, "google"))).toBe(
      SECRET,
    );

    // What the resolver caches (Redis) holds the envelope, never the secret.
    const resolved = await tenantResolver.resolveHost(
      new URL(issuerOf("sim-a", origin)).host,
    );
    expect(JSON.stringify(resolved)).not.toContain(SECRET);
    expect(resolved?.signIn.social[0]?.secret).toEqual(entry.secret);
    // The tenant's janus was rebuilt with the provider.
    const janus = await janusIssuers.forRequest(
      new Request(issuerOf("sim-a", origin)),
    );
    expect(janus === null ? null : socialOf(janus)).not.toBeNull();

    for (const spy of [warn, log]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
      spy.mockRestore();
    }
  });

  test("the same values again write nothing; a secret left out keeps the stored one", async () => {
    const before = await stored(a);
    const again = await as(ADMIN_A, SET, {
      t: a,
      i: { provider: "GOOGLE", clientId: "google-id", clientSecret: SECRET },
    });
    expect(again.data?.["setSocialProvider"]?.version).toBe(before.version);
    expect((await stored(a)).version).toBe(before.version);

    const renamed = await as(ADMIN_A, SET, {
      t: a,
      i: { provider: "GOOGLE", clientId: "google-id-2" },
    });
    expect(renamed.data?.["setSocialProvider"]?.social[0]?.clientId).toBe(
      "google-id-2",
    );
    const after = await stored(a);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.signIn.social[0]?.secret).toEqual(
      before.signIn.social[0]?.secret as NonNullable<
        (typeof before.signIn.social)[number]
      >["secret"],
    );
  });

  test("a secret sealed for tenant A does not open as tenant B's, and the skipped provider is reported without it", async () => {
    const tenantA = await tenantResolver.resolveHost(
      new URL(issuerOf("sim-a", origin)).host,
    );
    const tenantB = await tenantResolver.resolveHost(
      new URL(issuerOf("sim-b", origin)).host,
    );
    if (tenantA === null || tenantB === null) throw new Error("no tenant");
    expect(Object.keys(socialProvidersOf(tenantA, secretBox))).toEqual([
      "google",
    ]);
    const skipped: string[][] = [];
    const copied = { ...tenantB, signIn: tenantA.signIn };
    expect(
      socialProvidersOf(copied, secretBox, (provider, reason) =>
        skipped.push([provider, reason]),
      ),
    ).toEqual({});
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.[0]).toBe("google");
    expect(JSON.stringify(skipped)).not.toContain(SECRET);
  });

  test("with a provider on, every method can go off; then the provider cannot: NO_SIGN_IN_METHOD", async () => {
    const off = await as(ADMIN_A, METHODS, {
      t: a,
      m: [
        { type: "PASSKEY", enabled: false },
        { type: "EMAIL_CODE", enabled: false },
        { type: "MAGIC_LINK", enabled: false },
      ],
    });
    expect(
      off.data?.["updateSignInMethods"] === undefined
        ? null
        : enabledOf(off.data["updateSignInMethods"]),
    ).toEqual([]);
    const version = (await stored(a)).version;
    expect(codeOf(await as(ADMIN_A, REMOVE, { t: a, p: "GOOGLE" }))).toBe(
      "NO_SIGN_IN_METHOD",
    );
    expect(
      codeOf(
        await as(ADMIN_A, SET, {
          t: a,
          i: { provider: "GOOGLE", enabled: false },
        }),
      ),
    ).toBe("NO_SIGN_IN_METHOD");
    expect((await stored(a)).version).toBe(version);
  });

  test("the redirect URI follows the primary custom domain, as the runtime callback does", async () => {
    await as(ADMIN_C, SET, {
      t: c,
      i: { provider: "GOOGLE", clientId: "google-id", clientSecret: SECRET },
    });
    const id = new ObjectId(c);
    const claim = await domainStore.add(id, "auth.sim-c.com", 5);
    await mongo.db.domains.raw.updateOne(
      { _id: claim._id },
      { $set: { status: "verified", verifiedAt: new Date() } },
    );
    await domainStore.setPrimary(id, claim._id.toHexString());
    const policy = await policyOf(ADMIN_C, c);
    const resolved = await tenantResolver.resolveHost(
      new URL(issuerOf("sim-c", origin)).host,
    );
    expect(policy.social[0]?.callbackUrl).toBe(
      `${resolved?.issuer}/sign-in/social/google/callback`,
    );
    expect(policy.social[0]?.callbackUrl).toContain("auth.sim-c.com");
    await mongo.db.domains.raw.deleteMany({ tenantId: id });
    await tenantResolver.invalidate([new URL(issuerOf("sim-c", origin)).host]);
  });

  test("removing a provider drops its secret; removing it again writes nothing", async () => {
    await as(ADMIN_A, METHODS, {
      t: a,
      m: [{ type: "EMAIL_CODE", enabled: true }],
    });
    const removed = await as(OWNER_A, REMOVE, { t: a, p: "GOOGLE" });
    expect(removed.data?.["removeSocialProvider"]?.social).toEqual([]);
    const after = await stored(a);
    expect(after.signIn.social).toEqual([]);
    const again = await as(OWNER_A, REMOVE, { t: a, p: "GOOGLE" });
    expect(again.data?.["removeSocialProvider"]?.version).toBe(after.version);
    const janus = await janusIssuers.forRequest(
      new Request(issuerOf("sim-a", origin)),
    );
    expect(janus === null ? "none" : socialOf(janus)).toBeNull();
  });
});

describe("admin events", () => {
  test("each mutation recorded who did what to which target, and no secret; refusals recorded nothing", async () => {
    const events = await eventsOf(a);
    expect(events).toContainEqual({
      actor: ADMIN_A,
      action: "signInPolicy.update",
      target: { type: "signInPolicy", id: a },
    });
    expect(events).toContainEqual({
      actor: ADMIN_A,
      action: "socialProvider.set",
      target: { type: "socialProvider", id: "google" },
    });
    expect(events).toContainEqual({
      actor: OWNER_A,
      action: "socialProvider.remove",
      target: { type: "socialProvider", id: "google" },
    });
    expect(events.some((event) => event.actor === VIEWER_A)).toBe(false);
    const all = await mongo.db.adminEvents.raw.find({}).toArray();
    expect(JSON.stringify(all)).not.toContain(SECRET);
    expect(JSON.stringify(all)).not.toContain("google-id");
    // Tenant B's refused changes (NO_SIGN_IN_METHOD, unavailable, duplicate,
    // tenant A's admin) left no event. Its one accepted call, password off
    // where it already was, changed nothing and is recorded all the same.
    expect(await eventsOf(b)).toEqual([
      {
        actor: ADMIN_B,
        action: "signInPolicy.update",
        target: { type: "signInPolicy", id: b },
      },
    ]);
  });
});

describe("concurrent changes", () => {
  test("two admins each turning off a different last method: one is refused, a method stays", async () => {
    const id = (await tenantsService.create({ slug: "sim-race", name: "R" }))
      .id;
    await access.grantTenant(id, ADMIN_A, "admin");
    const [first, second] = await Promise.all([
      as(ADMIN_A, METHODS, { t: id, m: [{ type: "PASSKEY", enabled: false }] }),
      as(ADMIN_A, METHODS, {
        t: id,
        m: [{ type: "EMAIL_CODE", enabled: false }],
      }),
    ]);
    expect([codeOf(first), codeOf(second)].sort()).toEqual([
      "NO_SIGN_IN_METHOD",
      undefined,
    ] as unknown as string[]);
    expect(enabledOf(await policyOf(ADMIN_A, id))).toHaveLength(1);
  });

  test("a change that keeps losing the race is CONFLICT (409), nothing stored", async () => {
    const lost = new SignInPolicyService(
      {
        liveByIds: tenantsService.liveByIds.bind(tenantsService),
        updateSignIn: async () => {
          throw Object.create(OptimisticLockError.prototype);
        },
      } as unknown as typeof tenantsService,
      secretBox,
    );
    const refusal = await lost
      .updateMethods(b, [{ type: "magicLink", enabled: true }])
      .catch((error: unknown) => error);
    expect((refusal as GraphQLError).extensions).toMatchObject({
      code: "CONFLICT",
      http: { status: 409 },
    });
  });
});
