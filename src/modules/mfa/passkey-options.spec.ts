import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { totpCode } from "@softistx/janus/testing";
import { softwareAuthenticator } from "@softistx/janus-passkeys/testing";
import type { MemoryMailer } from "@softistx/mail";
import { createApp } from "@/app";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { janusIssuers } from "@/config/users";
import { settled } from "@/modules/auth/outbox";
import { passkeyThrottled } from "@/modules/passkeys/throttle";
import { SignInPolicyService } from "@/modules/sign-in-methods/service";
import { issuerOf, PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { originOf, rpIdOf } from "@/modules/users/rp";
import { SESSION_COOKIE } from "@/modules/users/tenant-janus";

// `requestSecondFactorPasskeyOptions` (clavix-api#371): a page that keeps only the
// challenge reads the passkey options again, with no attempt counted.

const memory = mailer as MemoryMailer;
let app = createApp();
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const policies = new SignInPolicyService(tenantsService, {
  seal: () => "",
  open: () => "",
} as never);

const url = (slug: string) => `${issuerOf(slug, origin)}/graphql`;
const tenantOf = async (slug: string) => {
  const tenant = await tenantResolver.resolveHost(
    `${slug}.${env.CLAVIX_DOMAIN}`,
  );
  if (tenant === null) throw new Error(`no tenant ${slug}`);
  return tenant;
};

interface Answer {
  data: Record<string, any> | null;
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
  const body = (await response.json()) as Omit<Answer, "cookies">;
  return {
    data: body.data ?? null,
    ...(body.errors === undefined ? {} : { errors: body.errors }),
    cookies: response.headers.getSetCookie(),
  };
}

const REQUEST = `mutation ($email: EmailAddress!) {
  requestSignInCode(email: $email) { challenge }
}`;
const VERIFY = `mutation ($challenge: String!, $code: String!) {
  verifySignInCode(challenge: $challenge, code: $code) {
    __typename
    ... on SecondFactorChallenge { challenge methods passkeyOptions }
  }
}`;
const CONFIRM_PASSKEY = `mutation ($challenge: String!, $assertion: String!) {
  confirmSecondFactorWithPasskey(challenge: $challenge, assertion: $assertion) {
    user { id email } newDevice recoveryCodesLeft expiresAt
  }
}`;
const ENROLL = "mutation { enrollSecondFactor { secret } }";
const ACTIVATE = `mutation ($code: String!) {
  activateSecondFactor(code: $code) { recoveryCodes }
}`;
const REG_OPTIONS =
  "mutation { passkeyRegistrationOptions { options challenge } }";
const REGISTER = `mutation ($c: String!, $r: String!) {
  registerPasskey(challenge: $c, response: $r, name: "Laptop") { id }
}`;

const codeOf = (answer: Answer) => answer.errors?.[0]?.extensions?.["code"];
const cookieOf = (answer: Answer) => {
  const header = answer.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return header === undefined ? "" : (header.split(";")[0] ?? "");
};
const challengeOf = (options: string) =>
  String((JSON.parse(options) as { challenge: unknown }).challenge);
const handleOf = (id: string) => Buffer.from(id).toString("base64url");

const A = "pkacme";
const B = "pkglobex";

/** A user of the tenant with TOTP and one registered passkey. */
async function holder(slug: string, email: string) {
  const auth = await janusIssuers.forRequest(new Request(url(slug)));
  if (auth === null) throw new Error("no janus");
  const user = await auth.create({ email });
  await auth.verifyEmail.confirm((await auth.verifyEmail.send(user)).token);
  const result = await auth.signInProven(
    (await auth.findUser(user.id)) ?? user,
  );
  if (result.status !== "signedIn") throw new Error("no session");
  const cookie = `${SESSION_COOKIE}=${result.token}`;
  const secret = (await gql(slug, ENROLL, {}, cookie)).data?.[
    "enrollSecondFactor"
  ].secret as string;
  await gql(slug, ACTIVATE, { code: totpCode(secret) }, cookie);
  const tenant = await tenantOf(slug);
  const authenticator = await softwareAuthenticator();
  const options = (await gql(slug, REG_OPTIONS, {}, cookie)).data?.[
    "passkeyRegistrationOptions"
  ] as { options: string; challenge: string };
  const response = await authenticator.register({
    challenge: challengeOf(options.options),
    origin: originOf(tenant),
    rpId: rpIdOf(tenant),
  });
  const done = await gql(
    slug,
    REGISTER,
    { c: options.challenge, r: JSON.stringify(response) },
    cookie,
  );
  expect(done.errors).toBeUndefined();
  return {
    id: user.id,
    email,
    authenticator,
    secret,
    handle: handleOf(user.id),
  };
}

/** Signs `email` in by e-mailed code: the challenge the hosted page holds. */
async function challengeFor(slug: string, email: string) {
  const before = memory.sent.length;
  const asked = await gql(slug, REQUEST, { email });
  await settled();
  const token = asked.data?.["requestSignInCode"].challenge as string;
  const code =
    /\b(\d{6})\b/.exec(
      memory.sent
        .slice(before)
        .filter((m) => JSON.stringify(m.to).includes(email))
        .at(-1)?.text ?? "",
    )?.[1] ?? "";
  const stopped = await gql(slug, VERIFY, { challenge: token, code });
  const out = stopped.data?.["verifySignInCode"];
  expect(out.__typename).toBe("SecondFactorChallenge");
  expect(out.methods).toContain("passkey");
  return out as { challenge: string; passkeyOptions: string };
}

/** The browser's answer to the challenge's `passkeyOptions`. */
async function assertion(
  slug: string,
  who: {
    authenticator: Awaited<ReturnType<typeof softwareAuthenticator>>;
    handle: string;
  },
  options: string,
  counter = 1,
) {
  const tenant = await tenantOf(slug);
  return JSON.stringify(
    await who.authenticator.assert({
      challenge: challengeOf(options),
      origin: originOf(tenant),
      rpId: rpIdOf(tenant),
      userHandle: who.handle,
      counter,
    }),
  );
}

const ADA = "ada@example.test";

const OPTIONS = `mutation ($challenge: String!) {
  requestSecondFactorPasskeyOptions(challenge: $challenge) { options }
}`;
const optionsOf = (answer: Answer) =>
  answer.data?.["requestSecondFactorPasskeyOptions"]?.options as string;

beforeAll(async () => {
  await tenantsService.create({ slug: A, name: "Acme", signUp: true });
  await policies.updateMfa((await tenantOf(A)).tenantId, { totp: true });
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
    "partitionedPasskeys",
  ]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

describe("requestSecondFactorPasskeyOptions", () => {
  test("answers the options of the issue step and the assertion built on them confirms", async () => {
    const ada = await holder(A, ADA);
    const challenge = await challengeFor(A, ADA);

    const again = await gql(A, OPTIONS, { challenge: challenge.challenge });
    expect(again.errors).toBeUndefined();
    expect(again.cookies).toEqual([]);
    expect(JSON.parse(optionsOf(again))).toEqual(
      JSON.parse(challenge.passkeyOptions),
    );

    const done = await gql(A, CONFIRM_PASSKEY, {
      challenge: challenge.challenge,
      assertion: await assertion(A, ada, optionsOf(again)),
    });
    expect(done.errors).toBeUndefined();
    expect(done.data?.["confirmSecondFactorWithPasskey"].user.email).toBe(ADA);
    expect(cookieOf(done)).not.toBe("");
  });

  test("counts no attempt and spends nothing, however often it is read", async () => {
    const ada = await holder(A, "ada2@example.test");
    const challenge = await challengeFor(A, "ada2@example.test");
    for (let i = 0; i < 8; i += 1) {
      const read = await gql(A, OPTIONS, { challenge: challenge.challenge });
      expect(read.errors).toBeUndefined();
    }
    // Still five attempts: one wrong answer leaves four, and the right one opens.
    const bob = await holder(A, "bob@example.test");
    const refused = await gql(A, CONFIRM_PASSKEY, {
      challenge: challenge.challenge,
      assertion: await assertion(A, bob, challenge.passkeyOptions),
    });
    expect(codeOf(refused)).toBe("CODE_INVALID");
    expect(refused.errors?.[0]?.extensions?.["attemptsLeft"]).toBe(4);
    const done = await gql(A, CONFIRM_PASSKEY, {
      challenge: challenge.challenge,
      assertion: await assertion(A, ada, challenge.passkeyOptions),
    });
    expect(done.errors).toBeUndefined();
  });

  test("a spent challenge is TOKEN_SPENT", async () => {
    const eve = await holder(A, "eve@example.test");
    const challenge = await challengeFor(A, "eve@example.test");
    const done = await gql(A, CONFIRM_PASSKEY, {
      challenge: challenge.challenge,
      assertion: await assertion(A, eve, challenge.passkeyOptions),
    });
    expect(done.errors).toBeUndefined();
    const late = await gql(A, OPTIONS, { challenge: challenge.challenge });
    expect(codeOf(late)).toBe("TOKEN_SPENT");
  });

  test("an expired challenge is refused", async () => {
    await holder(A, "zoe@example.test");
    const challenge = await challengeFor(A, "zoe@example.test");
    await oauthDb
      .collection("partitionedTokens")
      .updateMany(
        { partition: (await tenantOf(A)).tenantId },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
    const late = await gql(A, OPTIONS, { challenge: challenge.challenge });
    expect(codeOf(late)).toBe("TOKEN_EXPIRED");
    expect(late.data).toBeNull();
  });

  test("an unknown challenge is TOKEN_UNKNOWN", async () => {
    const unknown = await gql(A, OPTIONS, { challenge: "not-a-challenge" });
    expect(codeOf(unknown)).toBe("TOKEN_UNKNOWN");
  });

  test("a user with no passkey is SECOND_FACTOR_NOT_ENROLLED", async () => {
    await holder(A, "tom@example.test");
    // The passkey is removed after the challenge was issued.
    const challenge = await challengeFor(A, "tom@example.test");
    await oauthDb.collection("partitionedPasskeys").deleteMany({
      partition: (await tenantOf(A)).tenantId,
    });
    const refused = await gql(A, OPTIONS, { challenge: challenge.challenge });
    expect(codeOf(refused)).toBe("SECOND_FACTOR_NOT_ENROLLED");
  });

  test("a challenge of tenant A is unknown on tenant B", async () => {
    await tenantsService.create({ slug: B, name: "Globex", signUp: true });
    await policies.updateMfa((await tenantOf(B)).tenantId, { totp: true });
    await holder(A, "amy@example.test");
    const challenge = await challengeFor(A, "amy@example.test");
    const refused = await gql(B, OPTIONS, { challenge: challenge.challenge });
    expect(codeOf(refused)).toBe("TOKEN_UNKNOWN");
    expect(refused.data).toBeNull();
  });

  test("a suspended tenant is TENANT_SUSPENDED", async () => {
    await holder(A, "sue@example.test");
    const challenge = await challengeFor(A, "sue@example.test");
    const tenantId = (await tenantOf(A)).tenantId;
    await tenantsService.suspend(tenantId);
    try {
      const refused = await gql(A, OPTIONS, { challenge: challenge.challenge });
      expect(codeOf(refused)).toBe("TENANT_SUSPENDED");
    } finally {
      await tenantsService.reactivate(tenantId);
    }
  });

  test("a tenant that turned passkeys off refuses it and keeps the challenge", async () => {
    await holder(A, "kim@example.test");
    const challenge = await challengeFor(A, "kim@example.test");
    const tenantId = (await tenantOf(A)).tenantId;
    await policies.updateMethods(tenantId, [
      { type: "passkey", enabled: false },
    ]);
    try {
      const refused = await gql(A, OPTIONS, { challenge: challenge.challenge });
      expect(codeOf(refused)).toBe("SIGN_IN_METHOD_DISABLED");
    } finally {
      await policies.updateMethods(tenantId, [
        { type: "passkey", enabled: true },
      ]);
    }
    const read = await gql(A, OPTIONS, { challenge: challenge.challenge });
    expect(read.errors).toBeUndefined();
  });

  test("the passkey throttle applies: past the limit it is PASSKEY_THROTTLED (429) and reads nothing", async () => {
    await holder(A, "ray@example.test");
    const challenge = await challengeFor(A, "ray@example.test");
    let calls = 0;
    const limited = createApp({
      passkeyThrottle: {
        check: async () => {
          calls += 1;
          if (calls > 2) throw passkeyThrottled(9);
        },
      },
    });
    const saved = app;
    app = limited;
    try {
      for (let i = 0; i < 2; i += 1) {
        const ok = await gql(A, OPTIONS, { challenge: challenge.challenge });
        expect(ok.errors).toBeUndefined();
      }
      const response = await limited.request(url(A), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: (await tenantOf(A)).issuer.replace(/\/$/, ""),
        },
        body: JSON.stringify({
          query: OPTIONS,
          variables: { challenge: challenge.challenge },
        }),
      });
      const body = (await response.json()) as {
        errors?: { extensions: Record<string, unknown> }[];
      };
      expect(response.status).toBe(429);
      expect(body.errors?.[0]?.extensions["code"]).toBe("PASSKEY_THROTTLED");
      expect(response.headers.get("retry-after")).toBe("9");
    } finally {
      app = saved;
    }
  });

  test("an unknown host is NOT_FOUND and spends no throttle budget", async () => {
    let calls = 0;
    const limited = createApp({
      passkeyThrottle: {
        check: async () => {
          calls += 1;
        },
      },
    });
    const host = `http://nobody-here.${env.CLAVIX_DOMAIN}`;
    const response = await limited.request(`${host}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: host },
      body: JSON.stringify({ query: OPTIONS, variables: { challenge: "x" } }),
    });
    const body = (await response.json()) as {
      errors?: { extensions: Record<string, unknown> }[];
    };
    expect(body.errors?.[0]?.extensions["code"]).toBe("NOT_FOUND");
    expect(calls).toBe(0);
  });
});
