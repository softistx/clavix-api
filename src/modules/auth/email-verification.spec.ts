import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { JanusError } from "@softistx/janus";
import {
  createMemorySigningKeys,
  rotateSigningKeys,
  s256Challenge,
} from "@softistx/janus-oauth";
import type { MemoryMailer } from "@softistx/mail";
import { startTestRedis, type TestRedis } from "@softistx/redis/testing";
import { createLocalJWKSet, jwtVerify } from "jose";
import { createApp } from "@/app";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { openAppRedis } from "@/config/redis";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { authFor, claimsFor, janusIssuers } from "@/config/users";
import { VERIFY_EMAIL_PATH } from "@/mail/tenant-mail";
import { registerClient } from "@/modules/clients/register-client";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { SESSION_COOKIE } from "@/modules/users/tenant-janus";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { createTenantParOff } from "../../../test/tenant-par-off";
import {
  confirmEmailVerification,
  requestEmailVerification,
} from "./email-verification";
import { settled } from "./outbox";
import {
  createVerificationThrottle,
  type VerificationLimitConfig,
} from "./verification-throttle";

const memory = mailer as MemoryMailer;
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const url = (slug: string) => `${issuerOf(slug, origin)}/graphql`;
const hostOf = (slug: string) => issuerOf(slug, origin);

interface Answer {
  status: number;
  headers: Headers;
  data: Record<string, unknown> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
}

async function gql(
  app: ReturnType<typeof createApp>,
  slug: string,
  query: string,
  variables: Record<string, unknown> = {},
  { cookie, ip = "198.51.100.7" }: { cookie?: string; ip?: string } = {},
): Promise<Answer> {
  const response = await app.request(url(slug), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as Omit<Answer, "status" | "headers">;
  return {
    status: response.status,
    headers: response.headers,
    data: body.data ?? null,
    ...(body.errors === undefined ? {} : { errors: body.errors }),
  };
}

const REQUEST = "mutation { requestEmailVerification }";
const CONFIRM = `mutation ($token: String!) {
  confirmEmailVerification(token: $token) { id email emailVerified }
}`;
const ME = "{ currentUser { email emailVerified } }";
const codeOf = (answer: Answer) => answer.errors?.[0]?.extensions?.["code"];
const confirmed = (answer: Answer) =>
  answer.data?.["confirmEmailVerification"] as
    | { id: string; email: string; emailVerified: boolean }
    | undefined;

const janusOf = async (slug: string) => {
  const auth = await janusIssuers.forRequest(new Request(url(slug)));
  if (auth === null) throw new Error(`no janus for ${slug}`);
  return auth;
};

let counter = 0;
// An unverified user of the tenant with a session; `cookie` carries it.
async function signedIn(slug: string, email?: string) {
  counter += 1;
  const auth = await janusOf(slug);
  const user = await auth.create({
    email: email ?? `user${counter}@example.test`,
  });
  const result = await auth.signInProven(user);
  if (result.status !== "signedIn") throw new Error("no session");
  return { user, auth, cookie: `${SESSION_COOKIE}=${result.token}` };
}

const hasTo = (mail: (typeof memory.sent)[number], email: string) =>
  JSON.stringify(mail.to).includes(email);

// The verification mails sent to an address since `before`, and the token in the last link.
function mailsTo(email: string, before: number) {
  const mails = memory.sent.slice(before).filter((m) => hasTo(m, email));
  const link = /https?:\/\/[^\s"'<>]+\/verify\?token=[\w-]+/.exec(
    mails.at(-1)?.text ?? "",
  )?.[0];
  const token =
    link === undefined ? undefined : new URL(link).searchParams.get("token");
  return { mails, link, token: token ?? "" };
}

const app = createApp();

// Asks for the mail as `session` and returns it.
async function ask(
  slug: string,
  session: { user: { email: string }; cookie: string },
  appUnderTest = app,
) {
  const before = memory.sent.length;
  const answer = await gql(appUnderTest, slug, REQUEST, {}, session);
  await settled();
  return { answer, ...mailsTo(session.user.email, before) };
}

let redis: TestRedis;

beforeAll(async () => {
  for (const slug of ["acme", "globex", "paused"]) {
    await createTenantParOff(tenantsService, {
      slug,
      name: slug,
      signUp: true,
    });
  }
  redis = await startTestRedis();
}, 300_000);

afterAll(async () => {
  await settled();
  await redis?.stop();
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  for (const name of [
    "partitionedUsers",
    "partitionedSessions",
    "partitionedTokens",
  ]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

describe("requestEmailVerification", () => {
  test("mails the signed-in user a link to the tenant's hosted /verify page and answers true", async () => {
    const session = await signedIn("acme");
    const { answer, mails, link } = await ask("acme", session);
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ requestEmailVerification: true });
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(mails).toHaveLength(1);
    expect(link).toStartWith(`${hostOf("acme")}${VERIFY_EMAIL_PATH}?token=`);
  });

  test("an already verified user gets the same answer and no mail", async () => {
    const session = await signedIn("acme");
    await session.auth.setEmailVerified(session.user.id, true);
    const { answer, mails } = await ask("acme", session);
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ requestEmailVerification: true });
    expect(mails).toHaveLength(0);
  });

  test("is 401 UNAUTHENTICATED without a session, and sends nothing", async () => {
    const before = memory.sent.length;
    const answer = await gql(app, "acme", REQUEST);
    await settled();
    expect(answer.status).toBe(401);
    expect(codeOf(answer)).toBe("UNAUTHENTICATED");
    expect(memory.sent.length).toBe(before);
  });

  test("another tenant's session is anonymous here", async () => {
    const other = await signedIn("globex");
    const answer = await gql(app, "acme", REQUEST, {}, other);
    expect(answer.status).toBe(401);
    expect(codeOf(answer)).toBe("UNAUTHENTICATED");
  });

  test("the sixth request for one address in the window is EMAIL_VERIFICATION_THROTTLED, 429, with retryAfter and Retry-After", async () => {
    const session = await signedIn("acme");
    for (let i = 0; i < 5; i += 1) {
      expect((await ask("acme", session)).answer.status).toBe(200);
    }
    const before = memory.sent.length;
    const sixth = await gql(app, "acme", REQUEST, {}, session);
    await settled();
    expect(sixth.status).toBe(429);
    expect(codeOf(sixth)).toBe("EMAIL_VERIFICATION_THROTTLED");
    const retryAfter = sixth.errors?.[0]?.extensions?.["retryAfter"];
    expect(retryAfter).toBeGreaterThan(0);
    expect(Number(sixth.headers.get("retry-after"))).toBe(Number(retryAfter));
    expect(mailsTo(session.user.email, before).mails).toHaveLength(0);
  });
});

describe("confirmEmailVerification", () => {
  test("flips the flag, answers the user and keeps the session", async () => {
    const session = await signedIn("acme");
    expect(session.user.emailVerified).toBe(false);
    const { token } = await ask("acme", session);
    const answer = await gql(app, "acme", CONFIRM, { token }, session);
    expect(answer.status).toBe(200);
    expect(confirmed(answer)).toEqual({
      id: session.user.id,
      email: session.user.email,
      emailVerified: true,
    });
    expect(answer.headers.getSetCookie()).toHaveLength(0);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const me = await gql(app, "acme", ME, {}, session);
    expect(me.data).toEqual({
      currentUser: { email: session.user.email, emailVerified: true },
    });
  });

  test("is 401 UNAUTHENTICATED without a session, and the token is not spent", async () => {
    const session = await signedIn("acme");
    const { token } = await ask("acme", session);
    const anonymous = await gql(app, "acme", CONFIRM, { token });
    expect(anonymous.status).toBe(401);
    expect(codeOf(anonymous)).toBe("UNAUTHENTICATED");
    expect(
      confirmed(await gql(app, "acme", CONFIRM, { token }, session))
        ?.emailVerified,
    ).toBe(true);
  });

  test("an unknown token is EMAIL_VERIFICATION_INVALID, 400", async () => {
    const session = await signedIn("acme");
    const answer = await gql(app, "acme", CONFIRM, { token: "nope" }, session);
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe("EMAIL_VERIFICATION_INVALID");
  });

  test("a spent token is the same EMAIL_VERIFICATION_INVALID", async () => {
    const session = await signedIn("acme");
    const { token } = await ask("acme", session);
    expect((await gql(app, "acme", CONFIRM, { token }, session)).status).toBe(
      200,
    );
    const again = await gql(app, "acme", CONFIRM, { token }, session);
    expect(again.status).toBe(400);
    expect(codeOf(again)).toBe("EMAIL_VERIFICATION_INVALID");
  });

  test("an expired token is the same EMAIL_VERIFICATION_INVALID, and the flag stays off", async () => {
    const session = await signedIn("acme");
    const { token } = await ask("acme", session);
    await oauthDb
      .collection("partitionedTokens")
      .updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const answer = await gql(app, "acme", CONFIRM, { token }, session);
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe("EMAIL_VERIFICATION_INVALID");
    const me = await gql(app, "acme", ME, {}, session);
    expect(me.data).toEqual({
      currentUser: { email: session.user.email, emailVerified: false },
    });
  });

  test("a token for an address the user has since changed is the same EMAIL_VERIFICATION_INVALID", async () => {
    const session = await signedIn("acme");
    const { token } = await ask("acme", session);
    await session.auth.update(session.user.id, {
      email: `moved-${session.user.email}`,
    });
    const answer = await gql(app, "acme", CONFIRM, { token }, session);
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe("EMAIL_VERIFICATION_INVALID");
  });

  test("another account's token is refused and left unspent for its owner", async () => {
    const owner = await signedIn("acme");
    const intruder = await signedIn("acme");
    const { token } = await ask("acme", owner);
    const refused = await gql(app, "acme", CONFIRM, { token }, intruder);
    expect(refused.status).toBe(400);
    expect(codeOf(refused)).toBe("EMAIL_VERIFICATION_INVALID");
    const intruderMe = await gql(app, "acme", ME, {}, intruder);
    expect(intruderMe.data).toEqual({
      currentUser: { email: intruder.user.email, emailVerified: false },
    });
    const own = await gql(app, "acme", CONFIRM, { token }, owner);
    expect(confirmed(own)?.emailVerified).toBe(true);
  });

  test("a token of tenant A is refused on tenant B, even by the same address", async () => {
    const email = "shared@example.test";
    const a = await signedIn("acme", email);
    const b = await signedIn("globex", email);
    const { token } = await ask("acme", a);
    const answer = await gql(app, "globex", CONFIRM, { token }, b);
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe("EMAIL_VERIFICATION_INVALID");
    // A's session on B's host is anonymous.
    expect(codeOf(await gql(app, "globex", CONFIRM, { token }, a))).toBe(
      "UNAUTHENTICATED",
    );
    // The token still works for its own account on its own tenant.
    expect(
      confirmed(await gql(app, "acme", CONFIRM, { token }, a))?.emailVerified,
    ).toBe(true);
  });

  test("keeps the session open (no first proof)", async () => {
    const session = await signedIn("acme");
    const { token } = await ask("acme", session);
    await gql(app, "acme", CONFIRM, { token }, session);
    const me = await gql(app, "acme", ME, {}, session);
    expect(me.errors).toBeUndefined();
    expect((await session.auth.findUser(session.user.id))?.emailVerified).toBe(
      true,
    );
  });
});

describe("a suspended tenant", () => {
  test("refuses both operations with TENANT_SUSPENDED, 403, and sends nothing", async () => {
    const session = await signedIn("paused");
    const { token } = await ask("paused", session);
    const paused = await tenantResolver.resolveHost(
      new URL(hostOf("paused")).host,
    );
    await tenantsService.suspend(paused?.tenantId ?? "");
    try {
      const before = memory.sent.length;
      const requested = await gql(app, "paused", REQUEST, {}, session);
      expect(requested.status).toBe(403);
      expect(codeOf(requested)).toBe("TENANT_SUSPENDED");
      const confirm = await gql(app, "paused", CONFIRM, { token }, session);
      expect(confirm.status).toBe(403);
      expect(codeOf(confirm)).toBe("TENANT_SUSPENDED");
      await settled();
      expect(memory.sent.length).toBe(before);
    } finally {
      await tenantsService.reactivate(paused?.tenantId ?? "");
    }
    // The token was not spent while suspended.
    expect(
      confirmed(await gql(app, "paused", CONFIRM, { token }, session))
        ?.emailVerified,
    ).toBe(true);
  });
});

describe("the OIDC email_verified claim follows the flag", () => {
  const REDIRECT = "https://app.example/callback";
  const VERIFIER = "v".repeat(64);
  const keys = createMemorySigningKeys();
  const issuers = createClavixOAuthIssuers({
    dpopNonceSecret: "spec-dpop-nonce-secret",
    resolver: tenantResolver,
    db: oauthDb,
    signingKeysFor: () => keys,
    authFor,
    claimsFor,
    resourcesFor: () => ({}),
  });
  const at = (slug: string, path: string) => `${hostOf(slug)}${path}`;

  // authorize, approve as `userId`, exchange the code.
  async function tokensFor(slug: string, userId: string) {
    const authorize = await issuers.handle(
      new Request(
        at(
          slug,
          `/authorize?${new URLSearchParams({
            response_type: "code",
            client_id: "backend",
            redirect_uri: REDIRECT,
            code_challenge: await s256Challenge(VERIFIER),
            code_challenge_method: "S256",
            scope: "openid email",
            nonce: "n-0S6_WzA2Mj",
            state: "xyz",
          })}`,
        ),
      ),
    );
    expect(authorize.status).toBe(302);
    const consent = new URL(
      authorize.headers.get("location") ?? "",
      at(slug, "/"),
    );
    const server = await issuers.serverFor(new Request(at(slug, "/")));
    if (server === null) throw new Error("no server");
    const { redirectTo } = await server.approve(
      { id: userId },
      consent.searchParams.get("request_id") ?? "",
      { scopes: ["openid", "email"], authTime: new Date() },
    );
    const response = await issuers.handle(
      new Request(at(slug, "/token"), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa(`backend:${secret}`)}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: new URL(redirectTo).searchParams.get("code") ?? "",
          redirect_uri: REDIRECT,
          code_verifier: VERIFIER,
        }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      access_token: string;
      id_token: string;
    };
  }

  let secret = "";
  beforeAll(async () => {
    const tenant = await tenantResolver.resolveHost(
      new URL(hostOf("acme")).host,
    );
    await rotateSigningKeys(keys, {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
    const registered = await registerClient(
      {
        db: oauthDb,
        findTenant: (slug) => mongo.db.tenants.findFirst({ slug }),
      },
      {
        tenant: "acme",
        name: "Back end",
        clientId: "backend",
        redirectUris: [REDIRECT],
        type: "confidential",
      },
    );
    secret = registered.clientSecret ?? "";
    expect(tenant).not.toBeNull();
  });

  const claimsOf = async (userId: string) => {
    const tokens = await tokensFor("acme", userId);
    const userinfo = await issuers.handle(
      new Request(at("acme", "/userinfo"), {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    const jwks = createLocalJWKSet(
      (await (
        await issuers.handle(new Request(at("acme", "/jwks.json")))
      ).json()) as Parameters<typeof createLocalJWKSet>[0],
    );
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: hostOf("acme"),
      audience: "backend",
    });
    return {
      userinfo: (await userinfo.json()) as Record<string, unknown>,
      idToken: payload,
    };
  };

  test("false before the proof, true in userinfo and in the id_token after it", async () => {
    const session = await signedIn("acme");
    const before = await claimsOf(session.user.id);
    expect(before.userinfo["email_verified"]).toBe(false);
    expect(before.idToken["email_verified"]).toBe(false);
    const { token } = await ask("acme", session);
    await gql(app, "acme", CONFIRM, { token }, session);
    const after = await claimsOf(session.user.id);
    expect(after.userinfo["email_verified"]).toBe(true);
    expect(after.idToken["email_verified"]).toBe(true);
    expect(after.userinfo["email"]).toBe(session.user.email);
  });
});

describe("limits over Redis", () => {
  const roomy = 1_000;
  const base: VerificationLimitConfig = {
    userLimit: roomy,
    userWindowSeconds: 3600,
    ipLimit: roomy,
    ipWindowSeconds: 600,
    tenantLimit: roomy,
    tenantWindowSeconds: 3600,
  };
  beforeEach(() => redis.reset());

  // An app over a Redis with the given limits. A session asks for a mail
  // with its own address header, so janus's per-address limit never decides.
  async function setup(limits: VerificationLimitConfig) {
    const opened = await openAppRedis(
      redis.uri,
      () => {},
      undefined,
      undefined,
      limits,
    );
    for (let i = 0; i < 100; i += 1) {
      const ready = await opened.limits.verifyUser
        .peek({ tenantId: "ready", userId: "ready" }, 0)
        .then(
          () => true,
          () => false,
        );
      if (ready) break;
      await Bun.sleep(20);
    }
    const limited = createApp({
      verifyThrottle: createVerificationThrottle(opened.limits, (message) => {
        throw new Error(message); // a spec never runs with Redis down
      }),
    });
    const request = async (
      slug: string,
      session: { cookie: string },
      ip = "203.0.113.1",
    ) => gql(limited, slug, REQUEST, {}, { cookie: session.cookie, ip });
    return { request, close: () => opened.close() };
  }

  test("per user: the request past the limit is EMAIL_VERIFICATION_THROTTLED, 429, with retryAfter and Retry-After; another user is not affected", async () => {
    const { request, close } = await setup({ ...base, userLimit: 2 });
    const [one, two] = [await signedIn("acme"), await signedIn("acme")];
    expect((await request("acme", one)).status).toBe(200);
    expect((await request("acme", one)).status).toBe(200);
    const refused = await request("acme", one);
    expect(refused.status).toBe(429);
    expect(codeOf(refused)).toBe("EMAIL_VERIFICATION_THROTTLED");
    expect(refused.errors?.[0]?.extensions?.["retryAfter"]).toBeGreaterThan(0);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await request("acme", two)).status).toBe(200);
    await close();
  });

  test("per client address and tenant: past the limit is 429, another address and another tenant have their own budget", async () => {
    const { request, close } = await setup({ ...base, ipLimit: 2 });
    const a = [await signedIn("acme"), await signedIn("acme")];
    const [a1, a2] = a as [(typeof a)[number], (typeof a)[number]];
    const g = await signedIn("globex");
    expect((await request("acme", a1)).status).toBe(200);
    expect((await request("acme", a2)).status).toBe(200);
    const refused = await request("acme", a1);
    expect(refused.status).toBe(429);
    expect(codeOf(refused)).toBe("EMAIL_VERIFICATION_THROTTLED");
    expect((await request("acme", a1, "203.0.113.2")).status).toBe(200);
    expect((await request("globex", g)).status).toBe(200);
    await close();
  });

  test("per tenant: past the limit is 429 from any address, and tenant A never spends B's budget", async () => {
    const { request, close } = await setup({ ...base, tenantLimit: 2 });
    const users = [
      await signedIn("acme"),
      await signedIn("acme"),
      await signedIn("acme"),
    ];
    const [u1, u2, u3] = users as [
      (typeof users)[number],
      (typeof users)[number],
      (typeof users)[number],
    ];
    const g = await signedIn("globex");
    expect((await request("acme", u1, "198.51.100.1")).status).toBe(200);
    expect((await request("acme", u2, "198.51.100.2")).status).toBe(200);
    const refused = await request("acme", u3, "198.51.100.3");
    expect(refused.status).toBe(429);
    expect(codeOf(refused)).toBe("EMAIL_VERIFICATION_THROTTLED");
    expect((await request("globex", g, "198.51.100.1")).status).toBe(200);
    await close();
  });

  test("a refused user spends neither the address nor the tenant budget", async () => {
    const { request, close } = await setup({
      ...base,
      userLimit: 1,
      ipLimit: 2,
    });
    const first = await signedIn("acme");
    const second = await signedIn("acme");
    expect((await request("acme", first)).status).toBe(200);
    for (let i = 0; i < 5; i += 1) await request("acme", first);
    expect((await request("acme", second)).status).toBe(200);
    await close();
  });

  test("Redis down: the request goes through, logged, and the mail is sent", async () => {
    const opened = await openAppRedis(
      redis.uri,
      () => {},
      undefined,
      undefined,
      base,
    );
    const logs: string[] = [];
    const throttle = createVerificationThrottle(opened.limits, (m) =>
      logs.push(m),
    );
    await opened.close();
    const down = createApp({ verifyThrottle: throttle });
    const session = await signedIn("acme");
    const before = memory.sent.length;
    const answer = await gql(down, "acme", REQUEST, {}, session);
    await settled();
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ requestEmailVerification: true });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(mailsTo(session.user.email, before).mails).toHaveLength(1);
  });
});

describe("with a stubbed janus", () => {
  const stub = (verifyEmail: object) => ({ verifyEmail }) as never;

  test("a store outage on confirm is not turned into EMAIL_VERIFICATION_INVALID", async () => {
    const failure = Object.assign(new JanusError("STORE_FAILED"), {
      code: "STORE_FAILED",
    });
    const auth = stub({
      confirm: async () => {
        throw failure;
      },
    });
    await expect(confirmEmailVerification(auth, "t", "u1")).rejects.toBe(
      failure,
    );
  });

  test("the mail is not sent when the address has since passed to another user", async () => {
    const sent: unknown[] = [];
    const auth = stub({
      prepare: async () => ({
        send: async () => ({
          user: { id: "other", name: null },
          email: "a@b.c",
        }),
      }),
    });
    const mail = { verifyEmail: async (issued: unknown) => sent.push(issued) };
    expect(
      await requestEmailVerification(
        { auth, mail: mail as never },
        {
          id: "u1",
          email: "a@b.c",
        },
      ),
    ).toBe(true);
    await settled();
    expect(sent).toHaveLength(0);
  });
});
