import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Ceremony,
  softwareAuthenticator,
} from "@softistx/janus-passkeys/testing";
import { createApp } from "@/app";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver } from "@/config/tenancy";
import { janusIssuers } from "@/config/users";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { TenantsService } from "@/modules/tenants/tenants.service";
import { originOf, rpIdOf } from "@/users/rp";
import { buildTenantJanus, SESSION_COOKIE } from "@/users/tenant-janus";

const app = createApp();
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const service = new TenantsService(mongo.db.tenants, {
  onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
});

const url = (slug: string) => `${issuerOf(slug, origin)}/graphql`;
const janusOf = async (slug: string) => {
  const auth = await janusIssuers.forRequest(new Request(url(slug)));
  if (auth === null) throw new Error(`no janus for ${slug}`);
  return auth;
};
const tenantOf = async (slug: string) => {
  const tenant = await tenantResolver.resolveHost(
    `${slug}.${env.CLAVIX_DOMAIN}`,
  );
  if (tenant === null) throw new Error(`no tenant ${slug}`);
  return tenant;
};

interface Answer {
  status: number;
  data: Record<string, unknown> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
  cookies: string[];
}

async function gql(
  slug: string,
  query: string,
  variables: Record<string, unknown> = {},
  cookie?: string,
): Promise<Answer> {
  const response = await app.request(url(slug), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: (await tenantOf(slug)).issuer.replace(/\/$/, ""),
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as Omit<Answer, "status" | "cookies">;
  return {
    status: response.status,
    data: body.data ?? null,
    ...(body.errors === undefined ? {} : { errors: body.errors }),
    cookies: response.headers.getSetCookie(),
  };
}

const SIGN_IN_OPTIONS = `mutation {
  passkeySignInOptions { options challenge expiresAt }
}`;
const SIGN_IN = `mutation ($challenge: String!, $response: String!) {
  signInWithPasskey(challenge: $challenge, response: $response) {
    expiresAt user { id email emailVerified }
  }
}`;
const REGISTRATION = `mutation {
  passkeyRegistrationOptions { options challenge expiresAt }
}`;
const REGISTER = `mutation ($challenge: String!, $response: String!, $name: String!) {
  registerPasskey(challenge: $challenge, response: $response, name: $name) {
    id name transports backupEligible backedUp createdAt lastUsedAt
  }
}`;
const MINE = "{ myPasskeys { id name } }";
const REMOVE = "mutation ($id: ID!) { removePasskey(id: $id) }";
const ME = "{ currentUser { id email emailVerified } }";

const codeOf = (answer: Answer) => answer.errors?.[0]?.extensions?.["code"];
const cookieOf = (answer: Answer) => {
  const header = answer.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return header === undefined ? "" : (header.split(";")[0] ?? "");
};
const field = <T>(answer: Answer, name: string) =>
  answer.data?.[name] as T | undefined;
const challengeOf = (options: string) =>
  String((JSON.parse(options) as { challenge: unknown }).challenge);
const handleOf = (id: string) => Buffer.from(id).toString("base64url");

/** A user of the tenant with a fresh session; verified like an e-mail code sign-in leaves it. */
async function userOf(slug: string, email: string, verified = true) {
  const auth = await janusOf(slug);
  const user = await auth.create({ email });
  if (verified) {
    await auth.verifyEmail.confirm((await auth.verifyEmail.send(user)).token);
  }
  const result = await auth.signInProven(
    (await auth.findUser(user.id)) ?? user,
  );
  if (result.status !== "signedIn") throw new Error("no session");
  return { id: user.id, cookie: `${SESSION_COOKIE}=${result.token}` };
}

/** The user registers an authenticator through the API. */
async function enroll(
  slug: string,
  email: string,
  ceremony?: Partial<Ceremony>,
) {
  const { id, cookie } = await userOf(slug, email);
  const authenticator = await softwareAuthenticator();
  const tenant = await tenantOf(slug);
  const options = await gql(slug, REGISTRATION, {}, cookie);
  const registration = field<{ options: string; challenge: string }>(
    options,
    "passkeyRegistrationOptions",
  );
  if (registration === undefined) throw new Error("no registration options");
  const response = await authenticator.register({
    challenge: challengeOf(registration.options),
    origin: originOf(tenant),
    rpId: rpIdOf(tenant),
    ...ceremony,
  });
  const done = await gql(
    slug,
    REGISTER,
    {
      challenge: registration.challenge,
      response: JSON.stringify(response),
      name: "Laptop",
    },
    cookie,
  );
  return { id, cookie, authenticator, done, handle: handleOf(id) };
}

/** An assertion for the tenant's challenge, with whatever the case turns. */
async function assertion(
  slug: string,
  authenticator: Awaited<ReturnType<typeof softwareAuthenticator>>,
  handle: string,
  ceremony: Partial<Ceremony> = {},
) {
  const tenant = await tenantOf(slug);
  const issued = await gql(slug, SIGN_IN_OPTIONS);
  const challenge = field<{ options: string; challenge: string }>(
    issued,
    "passkeySignInOptions",
  );
  if (challenge === undefined) throw new Error("no sign-in options");
  const response = await authenticator.assert({
    challenge: challengeOf(challenge.options),
    origin: originOf(tenant),
    rpId: rpIdOf(tenant),
    userHandle: handle,
    counter: 1,
    ...ceremony,
  });
  return { challenge: challenge.challenge, response: JSON.stringify(response) };
}

const ADA = "ada@example.test";

beforeAll(async () => {
  await service.create({ slug: "acme", name: "Acme", signUp: true });
  await service.create({ slug: "globex", name: "Globex", signUp: true });
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  for (const name of [
    "partitionedUsers",
    "partitionedSessions",
    "partitionedTokens",
    "partitionedPasskeys",
  ]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

describe("register, then sign in", () => {
  test("a passkey registered while signed in signs the user in alone", async () => {
    const { id, authenticator, handle, done, cookie } = await enroll(
      "acme",
      ADA,
    );
    expect(done.errors).toBeUndefined();
    expect(field<{ name: string }>(done, "registerPasskey")?.name).toBe(
      "Laptop",
    );
    const mine = await gql("acme", MINE, {}, cookie);
    expect(field<unknown[]>(mine, "myPasskeys")).toHaveLength(1);

    const attempt = await assertion("acme", authenticator, handle);
    const signed = await gql("acme", SIGN_IN, attempt);
    expect(signed.errors).toBeUndefined();
    expect(
      field<{ user: { id: string } }>(signed, "signInWithPasskey"),
    ).toMatchObject({ user: { id, email: ADA, emailVerified: true } });
    const header = signed.cookies.find((c) =>
      c.startsWith(`${SESSION_COOKIE}=`),
    );
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).not.toContain("Domain");

    const me = await gql("acme", ME, {}, cookieOf(signed));
    expect(field<{ email: string }>(me, "currentUser")?.email).toBe(ADA);
  });

  test("the sign-in challenge is spent by its first try", async () => {
    const { authenticator, handle } = await enroll("acme", "once@example.test");
    const attempt = await assertion("acme", authenticator, handle);
    expect((await gql("acme", SIGN_IN, attempt)).errors).toBeUndefined();
    const again = await gql("acme", SIGN_IN, attempt);
    expect(again.status).toBe(401);
    expect(codeOf(again)).toBe("PASSKEY_INVALID");
  });
});

describe("refusals are one PASSKEY_INVALID, 401", () => {
  test("another rpId (another tenant's host), another origin, an unknown credential, an unverified user", async () => {
    const { authenticator, handle } = await enroll("acme", "bob@example.test");
    const stranger = await softwareAuthenticator();
    const globex = await tenantOf("globex");
    const cases: [
      string,
      Awaited<ReturnType<typeof softwareAuthenticator>>,
      Partial<Ceremony>,
    ][] = [
      ["another tenant's rpId", authenticator, { rpId: rpIdOf(globex) }],
      ["another origin", authenticator, { origin: originOf(globex) }],
      ["an unknown credential", stranger, {}],
      ["no user verification", authenticator, { userVerified: false }],
      [
        "another user handle",
        authenticator,
        { userHandle: handleOf("nobody") },
      ],
    ];
    const messages = new Set<string>();
    for (const [label, who, ceremony] of cases) {
      const attempt = await assertion("acme", who, handle, ceremony);
      const refused = await gql("acme", SIGN_IN, attempt);
      expect([label, refused.status]).toEqual([label, 401]);
      expect([label, codeOf(refused)]).toEqual([label, "PASSKEY_INVALID"]);
      expect(refused.cookies).toEqual([]);
      messages.add(refused.errors?.[0]?.message ?? "");
    }
    // The answer tells nothing: one message for every case.
    expect(messages.size).toBe(1);
    // The right assertion still works after all the refusals.
    const ok = await gql(
      "acme",
      SIGN_IN,
      await assertion("acme", authenticator, handle),
    );
    expect(ok.errors).toBeUndefined();
  });

  test("an unknown or garbled challenge or response is the same refusal", async () => {
    const { authenticator, handle } = await enroll("acme", "carl@example.test");
    const attempt = await assertion("acme", authenticator, handle);
    for (const bad of [
      { challenge: "nope", response: attempt.response },
      { challenge: attempt.challenge, response: "not json" },
    ]) {
      const refused = await gql("acme", SIGN_IN, bad);
      expect(refused.status).toBe(401);
      expect(codeOf(refused)).toBe("PASSKEY_INVALID");
    }
  });
});

describe("tenants", () => {
  test("tenant A's passkey is refused on tenant B, even with the same e-mail there", async () => {
    const onAcme = await enroll("acme", "dana@example.test");
    // Dana exists on globex too, with her own (other) passkey.
    const onGlobex = await enroll("globex", "dana@example.test");
    // The globex page is asked for options, the acme authenticator answers them.
    for (const ceremony of [{}, { rpId: rpIdOf(await tenantOf("acme")) }]) {
      const attempt = await assertion(
        "globex",
        onAcme.authenticator,
        onAcme.handle,
        ceremony,
      );
      const refused = await gql("globex", SIGN_IN, attempt);
      expect(refused.status).toBe(401);
      expect(codeOf(refused)).toBe("PASSKEY_INVALID");
      expect(refused.cookies).toEqual([]);
    }
    // An assertion made on acme's own options, replayed on globex, is refused too.
    const acmeAttempt = await assertion(
      "acme",
      onAcme.authenticator,
      onAcme.handle,
    );
    expect(codeOf(await gql("globex", SIGN_IN, acmeAttempt))).toBe(
      "PASSKEY_INVALID",
    );
    // Each still signs in on its own tenant.
    expect(
      (
        await gql(
          "globex",
          SIGN_IN,
          await assertion("globex", onGlobex.authenticator, onGlobex.handle),
        )
      ).errors,
    ).toBeUndefined();
    // And a passkey list is the tenant's own: the acme session sees nothing on globex.
    const none = await gql("globex", MINE, {}, onAcme.cookie);
    expect(codeOf(none)).toBe("UNAUTHENTICATED");
  });
});

describe("registration", () => {
  test("an unverified e-mail cannot register", async () => {
    const { cookie } = await userOf("acme", "eve@example.test", false);
    const refused = await gql("acme", REGISTRATION, {}, cookie);
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe("EMAIL_UNVERIFIED");
  });

  test("a verified e-mail gets registration options", async () => {
    const { cookie } = await userOf("acme", "grace@example.test");
    const allowed = await gql("acme", REGISTRATION, {}, cookie);
    expect(allowed.errors).toBeUndefined();
  });

  test("anonymous callers are UNAUTHENTICATED, 401, and can ask for sign-in options", async () => {
    for (const query of [REGISTRATION, MINE]) {
      const refused = await gql("acme", query);
      expect(refused.status).toBe(401);
      expect(codeOf(refused)).toBe("UNAUTHENTICATED");
    }
    const options = await gql("acme", SIGN_IN_OPTIONS);
    expect(options.errors).toBeUndefined();
  });

  test("a response that does not verify is PASSKEY_INVALID and spends the challenge", async () => {
    const { cookie } = await userOf("acme", "fay@example.test");
    const asked = field<{ options: string; challenge: string }>(
      await gql("acme", REGISTRATION, {}, cookie),
      "passkeyRegistrationOptions",
    );
    const authenticator = await softwareAuthenticator();
    const tenant = await tenantOf("acme");
    const response = JSON.stringify(
      await authenticator.register({
        challenge: challengeOf(asked?.options ?? ""),
        origin: originOf(tenant),
        rpId: rpIdOf(otherRelyingParty(tenant)),
      }),
    );
    const refused = await gql(
      "acme",
      REGISTER,
      { challenge: asked?.challenge ?? "", response, name: "Laptop" },
      cookie,
    );
    expect(refused.status).toBe(400);
    expect(codeOf(refused)).toBe("PASSKEY_INVALID");
    const mine = await gql("acme", MINE, {}, cookie);
    expect(field<unknown[]>(mine, "myPasskeys")).toEqual([]);
  });

  test("a non-JSON response is BAD_USER_INPUT, 400", async () => {
    const { cookie } = await userOf("acme", "ivan@example.test");
    const asked = field<{ challenge: string }>(
      await gql("acme", REGISTRATION, {}, cookie),
      "passkeyRegistrationOptions",
    );
    const refused = await gql(
      "acme",
      REGISTER,
      {
        challenge: asked?.challenge ?? "",
        response: "not json",
        name: "Laptop",
      },
      cookie,
    );
    expect(refused.status).toBe(400);
    expect(codeOf(refused)).toBe("BAD_USER_INPUT");
  });

  test("a sign-in challenge is no registration challenge, and the reverse", async () => {
    const { cookie } = await userOf("acme", "hana@example.test");
    const signIn = field<{ challenge: string }>(
      await gql("acme", SIGN_IN_OPTIONS),
      "passkeySignInOptions",
    );
    const crossed = await gql(
      "acme",
      REGISTER,
      { challenge: signIn?.challenge ?? "", response: "{}", name: "Laptop" },
      cookie,
    );
    expect(crossed.errors).toBeDefined();
    const registration = field<{ challenge: string }>(
      await gql("acme", REGISTRATION, {}, cookie),
      "passkeyRegistrationOptions",
    );
    const back = await gql("acme", SIGN_IN, {
      challenge: registration?.challenge ?? "",
      response: "{}",
    });
    expect(back.status).toBe(401);
    expect(codeOf(back)).toBe("PASSKEY_INVALID");
  });
});

// A registration made for another relying party: the tenant's host with a label prepended is a different rpId.
const otherRelyingParty = (tenant: { issuer: string }) => ({
  issuer: tenant.issuer.replace("://", "://other."),
});

describe("removal", () => {
  test("a removed passkey no longer signs in; another user's cannot be removed", async () => {
    const mine = await enroll("acme", "gus@example.test");
    const theirs = await enroll("acme", "hal@example.test");
    const listed = await gql("acme", MINE, {}, mine.cookie);
    const [passkey] = field<{ id: string }[]>(listed, "myPasskeys") ?? [];
    const theirId = field<{ id: string }[]>(
      await gql("acme", MINE, {}, theirs.cookie),
      "myPasskeys",
    )?.[0]?.id;

    // Another user's credential id removes nothing.
    const foreign = await gql("acme", REMOVE, { id: theirId }, mine.cookie);
    expect(field<boolean>(foreign, "removePasskey")).toBe(false);
    expect(
      (
        await gql(
          "acme",
          SIGN_IN,
          await assertion("acme", theirs.authenticator, theirs.handle),
        )
      ).errors,
    ).toBeUndefined();

    const removed = await gql("acme", REMOVE, { id: passkey?.id }, mine.cookie);
    expect(field<boolean>(removed, "removePasskey")).toBe(true);
    const refused = await gql(
      "acme",
      SIGN_IN,
      await assertion("acme", mine.authenticator, mine.handle),
    );
    expect(refused.status).toBe(401);
    expect(codeOf(refused)).toBe("PASSKEY_INVALID");
  });
});

describe("development over http", () => {
  test("a tenant on an http .localhost origin builds a janus with its real rpId and origin, passkeys on", async () => {
    const tenant = await tenantOf("acme");
    const issuer = "http://acme.clavix.localhost:3000";
    const janus = buildTenantJanus(oauthDb, { ...tenant, issuer });
    expect(janus.passkeys).toBeDefined();
    expect(rpIdOf({ issuer })).toBe("acme.clavix.localhost");
    expect(originOf({ issuer })).toBe(issuer);
  });
});
