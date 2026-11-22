import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { totpCode } from "@softistx/janus/testing";
import { z } from "zod";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { secretBox } from "@/config/keys";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import { settled } from "@/modules/auth";
import { SignInPolicyService } from "@/modules/sign-in-methods";
import { issuerOf, PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { SESSION_COOKIE } from "@/modules/users";
import { createTestApp } from "~/app";
import { at } from "~/body";
import { clientHeaders } from "~/client-header";
import { fetchDouble } from "~/fetch-double";
import { type Answer, answerOf } from "~/gql-answer";
import { memoryMailerOf } from "~/memory-mailer-of";
import { quietSocial } from "~/ports";

// The second-factor challenge on the sign-in paths mfa.spec does not walk
// (a magic link, a social provider), its freshness window, a suspended
// tenant, and the usage it records (clavix-api#290).

const memory = memoryMailerOf(mailer);
const app = createTestApp();
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const policies = new SignInPolicyService(
  tenantsService,
  quietSocial(),
  secretBox,
  () => {},
);

const url = (slug: string) => `${issuerOf(slug, origin)}/graphql`;
const tenantOf = async (slug: string) => {
  const tenant = await tenantResolver.resolveHost(
    `${slug}.${env.CLAVIX_DOMAIN}`,
  );
  if (tenant === null) throw new Error(`no tenant ${slug}`);
  return tenant;
};

async function gql(
  slug: string,
  query: string,
  variables: Record<string, unknown> = {},
  cookie?: string,
): Promise<Answer> {
  const response = await app.request(url(slug), {
    method: "POST",
    headers: {
      ...clientHeaders,
      "content-type": "application/json",
      origin: (await tenantOf(slug)).issuer.replace(/\/$/, ""),
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ query, variables }),
  });
  return answerOf(response);
}

const CHALLENGE = "... on SecondFactorChallenge { challenge methods returnTo }";
const REQUEST_CODE = `mutation ($email: EmailAddress!) {
  requestSignInCode(email: $email) { challenge }
}`;
const VERIFY_CODE = `mutation ($challenge: String!, $code: String!) {
  verifySignInCode(challenge: $challenge, code: $code) {
    __typename ... on SignedIn { user { id } } ${CHALLENGE}
  }
}`;
const REQUEST_LINK = `mutation ($email: EmailAddress!) {
  requestMagicLink(email: $email) { expiresAt }
}`;
const CONFIRM_LINK = `mutation ($token: String!) {
  confirmMagicLink(token: $token) {
    __typename ... on SignedIn { user { id } } ${CHALLENGE}
  }
}`;
const SOCIAL_START = `mutation ($r: String) {
  socialSignInStart(provider: "github", returnTo: $r) { url flow }
}`;
const SOCIAL_COMPLETE = `mutation ($u: String!, $f: String!) {
  socialSignInComplete(callbackUrl: $u, flow: $f) {
    __typename ... on SocialSignedIn { user { id } } ${CHALLENGE}
  }
}`;
const CONFIRM = `mutation ($challenge: String!, $code: String!) {
  confirmSecondFactor(challenge: $challenge, code: $code) { user { id } }
}`;
const ENROLL = "mutation { enrollSecondFactor { secret } }";
const ACTIVATE = `mutation ($code: String!) {
  activateSecondFactor(code: $code) { recoveryCodes }
}`;
const CONFIRMED_UNTIL = "{ sessionConfirmedUntil }";
const ME = "{ currentUser { id } }";

const codeOf = (answer: Answer) => answer.errors?.[0]?.extensions?.["code"];
const cookieOf = (answer: Answer) => {
  const header = answer.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return header === undefined ? "" : (header.split(";")[0] ?? "");
};
/** A code of the next TOTP step: the current one was spent by the activation. */
const nextCode = (secret: string) =>
  totpCode(secret, new Date(Date.now() + 30_000));

/** The last mail sent to `email` since `before`. */
const mailTo = (before: number, email: string) =>
  memory.sent
    .slice(before)
    .filter((m) => JSON.stringify(m.to).includes(email))
    .at(-1)?.text ?? "";

async function signInByCode(slug: string, email: string) {
  const before = memory.sent.length;
  const asked = await gql(slug, REQUEST_CODE, { email });
  await settled();
  const code = /\b(\d{6})\b/.exec(mailTo(before, email))?.[1] ?? "";
  return gql(slug, VERIFY_CODE, {
    challenge: at(asked.data, "requestSignInCode.challenge"),
    code,
  });
}

async function signInByLink(slug: string, email: string) {
  const before = memory.sent.length;
  await gql(slug, REQUEST_LINK, { email });
  await settled();
  const link = /https?:\/\/[^\s"'<>]+\/sign-in\/link\?token=[\w-]+/.exec(
    mailTo(before, email),
  )?.[0];
  const token =
    link === undefined ? "" : new URL(link).searchParams.get("token");
  return gql(slug, CONFIRM_LINK, { token });
}

/** Enrols and activates TOTP for the session's user; the secret. */
async function turnOn(slug: string, cookie: string) {
  const enrolled = await gql(slug, ENROLL, {}, cookie);
  const secret = at(enrolled.data, "enrollSecondFactor.secret", z.string());
  const activated = await gql(
    slug,
    ACTIVATE,
    { code: totpCode(secret) },
    cookie,
  );
  expect(activated.errors).toBeUndefined();
  return secret;
}

/** A user of the tenant signed in by code, with TOTP on; the secret. */
async function holder(slug: string, email: string) {
  const first = await signInByCode(slug, email);
  expect(at(first.data, "verifySignInCode.__typename")).toBe("SignedIn");
  return turnOn(slug, cookieOf(first));
}

/** GitHub's three endpoints, answered in place of the network while `run` runs. */
function github(email: string) {
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { ...clientHeaders, "content-type": "application/json" },
    });
  const fake = fetchDouble(async (input, init) => {
    const { url } = new Request(input, init);
    if (url === "https://github.com/login/oauth/access_token") {
      return json({ access_token: "gh-access", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") {
      return json({ id: 4242, name: "Ada Lovelace" });
    }
    if (url === "https://api.github.com/user/emails") {
      return json([{ email, primary: true, verified: true }]);
    }
    return new Response("unexpected", { status: 500 });
  });
  return async <T>(work: () => Promise<T>): Promise<T> => {
    const real = globalThis.fetch;
    globalThis.fetch = fake;
    try {
      return await work();
    } finally {
      globalThis.fetch = real;
    }
  };
}

async function socialSignIn(slug: string, email: string, returnTo?: string) {
  const started = await gql(slug, SOCIAL_START, { r: returnTo ?? null });
  const start = at(
    started.data,
    "socialSignInStart",
    z.looseObject({ url: z.string(), flow: z.string() }),
  );
  const { url: to, flow } = start;
  const state = new URL(to).searchParams.get("state") ?? "";
  return github(email)(() =>
    gql(slug, SOCIAL_COMPLETE, {
      u: `${issuerOf(slug, origin)}/sign-in/social/github/callback?code=gh-code&state=${encodeURIComponent(state)}`,
      f: flow,
    }),
  );
}

const SLUG = {
  link: "chp-link",
  social: "chp-social",
  fresh: "chp-fresh",
  paused: "chp-paused",
} as const;
let pausedId = "";

beforeAll(async () => {
  for (const slug of Object.values(SLUG)) {
    const created = await tenantsService.create({
      slug,
      name: slug,
      signUp: true,
    });
    const id = created._id.toHexString();
    await policies.updateMfa(id, { totp: true });
    if (slug === SLUG.link) {
      await policies.updateMethods(id, [{ type: "magicLink", enabled: true }]);
    }
    if (slug === SLUG.social) {
      await policies.setSocial(id, {
        provider: "github",
        clientId: "gh-client-chp",
        clientSecret: "gh-secret-chp",
      });
    }
    if (slug === SLUG.paused) pausedId = id;
  }
});

afterEach(() => {
  mock.restore();
});

afterAll(async () => {
  await settled();
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

describe("a magic link to a TOTP holder", () => {
  test("answers the challenge with no session, records no activity until it is confirmed", async () => {
    const secret = await holder(SLUG.link, "link@chp.test");
    const active = spyOn(usageService, "recordActive");

    const stopped = await signInByLink(SLUG.link, "link@chp.test");
    const challenge = at(
      stopped.data,
      "confirmMagicLink",
      z.looseObject({ methods: z.array(z.string()), challenge: z.string() }),
    );
    expect(challenge).toMatchObject({
      __typename: "SecondFactorChallenge",
      returnTo: null,
    });
    expect(challenge.methods).toContain("totp");
    expect(cookieOf(stopped)).toBe("");
    expect(active).not.toHaveBeenCalled();

    const confirmed = await gql(SLUG.link, CONFIRM, {
      challenge: challenge.challenge,
      code: nextCode(secret),
    });
    expect(confirmed.errors).toBeUndefined();
    const userId = at(
      confirmed.data,
      "confirmSecondFactor.user.id",
      z.string(),
    );
    expect(active).toHaveBeenCalledTimes(1);
    expect(active.mock.calls[0]?.[1]).toBe(userId);
    const session = cookieOf(confirmed);
    expect(
      at((await gql(SLUG.link, ME, {}, session)).data, "currentUser.id"),
    ).toBe(userId);
  });
});

describe("a social sign-in of a TOTP holder", () => {
  test("answers the challenge with the flow's returnTo, and no session until it is confirmed", async () => {
    const first = await socialSignIn(SLUG.social, "social@chp.test");
    expect(at(first.data, "socialSignInComplete.__typename")).toBe(
      "SocialSignedIn",
    );
    const secret = await turnOn(SLUG.social, cookieOf(first));

    const stopped = await socialSignIn(
      SLUG.social,
      "social@chp.test",
      "/account",
    );
    const challenge = at(
      stopped.data,
      "socialSignInComplete",
      z.looseObject({ methods: z.array(z.string()), challenge: z.string() }),
    );
    expect(challenge).toMatchObject({
      __typename: "SecondFactorChallenge",
      returnTo: "/account",
    });
    expect(cookieOf(stopped)).toBe("");

    const confirmed = await gql(SLUG.social, CONFIRM, {
      challenge: challenge.challenge,
      code: nextCode(secret),
    });
    expect(confirmed.errors).toBeUndefined();
    expect(at(confirmed.data, "confirmSecondFactor.user.id")).toBe(
      at(first.data, "socialSignInComplete.user.id"),
    );
    expect(cookieOf(confirmed)).not.toBe("");
  });
});

describe("the freshness window (freshWithin 10m)", () => {
  test("a fresh session is confirmed for ten minutes; past them enrolment is STEP_UP_REQUIRED", async () => {
    const signed = await signInByCode(SLUG.fresh, "fresh@chp.test");
    const cookie = cookieOf(signed);
    const userId = at(signed.data, "verifySignInCode.user.id", z.string());
    const until = async () =>
      new Date(
        at(
          (await gql(SLUG.fresh, CONFIRMED_UNTIL, {}, cookie)).data,
          "sessionConfirmedUntil",
          z.string(),
        ),
      ).getTime();

    const fresh = await until();
    expect(fresh).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(fresh).toBeLessThanOrEqual(Date.now() + 10 * 60_000);

    await oauthDb
      .collection("partitionedSessions")
      .updateMany(
        { userId },
        { $set: { authenticatedAt: new Date(Date.now() - 11 * 60_000) } },
      );
    expect(await until()).toBeLessThan(Date.now());
    const stale = await gql(SLUG.fresh, ENROLL, {}, cookie);
    expect(codeOf(stale)).toBe("STEP_UP_REQUIRED");
    expect(stale.status).toBe(403);
  });
});

describe("a tenant suspended between the challenge and its answer", () => {
  test("is TENANT_SUSPENDED with no session; reactivated, the same challenge opens one", async () => {
    const secret = await holder(SLUG.paused, "paused@chp.test");
    const stopped = await signInByCode(SLUG.paused, "paused@chp.test");
    const challenge = at(
      stopped.data,
      "verifySignInCode.challenge",
      z.string(),
    );
    const active = spyOn(usageService, "recordActive");

    await tenantsService.suspend(pausedId);
    try {
      const refused = await gql(SLUG.paused, CONFIRM, {
        challenge,
        code: nextCode(secret),
      });
      expect(codeOf(refused)).toBe("TENANT_SUSPENDED");
      expect(cookieOf(refused)).toBe("");
      expect(active).not.toHaveBeenCalled();
    } finally {
      await tenantsService.reactivate(pausedId);
    }

    const confirmed = await gql(SLUG.paused, CONFIRM, {
      challenge,
      code: nextCode(secret),
    });
    expect(confirmed.errors).toBeUndefined();
    expect(cookieOf(confirmed)).not.toBe("");
    expect(active).toHaveBeenCalledTimes(1);
  });
});
