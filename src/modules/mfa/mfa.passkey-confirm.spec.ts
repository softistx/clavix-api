import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { totpCode } from "@softistx/janus/testing";
import { softwareAuthenticator } from "@softistx/janus-passkeys/testing";
import { z } from "zod";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { janusIssuers } from "@/config/users";
import { settled } from "@/modules/auth";
import { SignInPolicyService } from "@/modules/sign-in-methods";
import { issuerOf, PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { originOf, rpIdOf, SESSION_COOKIE } from "@/modules/users";
import { createTestApp } from "~/app";
import { at } from "~/body";
import { challengeOfOptions } from "~/challenge-of";
import { clientHeaders } from "~/client-header";
import { type Answer, answerOf } from "~/gql-answer";
import { memoryMailerOf } from "~/memory-mailer-of";
import { defined } from "~/narrow";
import { testSecrets } from "~/ports";

// `confirmSecondFactorWithPasskey` (clavix-api#293): the hosted second-factor
// page answers a `SecondFactorChallenge` with a passkey bound to it.

const memory = memoryMailerOf(mailer);
const app = createTestApp();
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const policies = new SignInPolicyService(
  tenantsService,
  testSecrets(),
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
const CONFIRM_TOTP = `mutation ($challenge: String!, $code: String!) {
  confirmSecondFactor(challenge: $challenge, code: $code) { user { id } }
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
const ME = "{ currentUser { id email } }";

const codeOf = (answer: Answer) => answer.errors?.[0]?.extensions?.["code"];
const cookieOf = (answer: Answer) => {
  const header = answer.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return header === undefined ? "" : (header.split(";")[0] ?? "");
};
const challengeOf = challengeOfOptions;
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
  const secret = at(
    (await gql(slug, ENROLL, {}, cookie)).data,
    "enrollSecondFactor.secret",
    z.string(),
  );
  await gql(slug, ACTIVATE, { code: totpCode(secret) }, cookie);
  const tenant = await tenantOf(slug);
  const authenticator = await softwareAuthenticator();
  const options = at(
    (await gql(slug, REG_OPTIONS, {}, cookie)).data,
    "passkeyRegistrationOptions",
    z.looseObject({ options: z.string(), challenge: z.string() }),
  );
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
  const token = at(asked.data, "requestSignInCode.challenge", z.string());
  const code =
    /\b(\d{6})\b/.exec(
      memory.sent
        .slice(before)
        .filter((m) => JSON.stringify(m.to).includes(email))
        .at(-1)?.text ?? "",
    )?.[1] ?? "";
  const stopped = await gql(slug, VERIFY, { challenge: token, code });
  const out = at(
    stopped.data,
    "verifySignInCode",
    z.looseObject({
      __typename: z.string(),
      methods: z.array(z.string()),
      challenge: z.string(),
      passkeyOptions: z.string(),
    }),
  );
  expect(out.__typename).toBe("SecondFactorChallenge");
  expect(out.methods).toContain("passkey");
  return out;
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
const BOB = "bob@example.test";

beforeAll(async () => {
  await tenantsService.create({ slug: A, name: "Acme", signUp: true });
  await tenantsService.create({ slug: B, name: "Globex", signUp: true });
  for (const slug of [A, B]) {
    await policies.updateMfa((await tenantOf(slug)).tenantId, { totp: true });
  }
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

describe("confirmSecondFactorWithPasskey", () => {
  test("a passkey of the user answers the challenge once and opens the session", async () => {
    const ada = await holder(A, ADA);
    const challenge = await challengeFor(A, ADA);
    const response = await assertion(A, ada, challenge.passkeyOptions);

    const done = await gql(A, CONFIRM_PASSKEY, {
      challenge: challenge.challenge,
      assertion: response,
    });
    expect(done.errors).toBeUndefined();
    const out = at(
      done.data,
      "confirmSecondFactorWithPasskey",
      z.looseObject({
        user: z.looseObject({ email: z.string() }),
        recoveryCodesLeft: z.number().or(z.null()),
      }),
    );
    expect(out.user.email).toBe(ADA);
    expect(out.recoveryCodesLeft).toBeNull();
    const session = cookieOf(done);
    expect(session).not.toBe("");
    expect(at((await gql(A, ME, {}, session)).data, "currentUser.email")).toBe(
      ADA,
    );

    // The challenge is spent: the same answer opens nothing more.
    const again = await gql(A, CONFIRM_PASSKEY, {
      challenge: challenge.challenge,
      assertion: await assertion(A, ada, challenge.passkeyOptions, 2),
    });
    expect(codeOf(again)).toBe("TOKEN_SPENT");
    expect(cookieOf(again)).toBe("");
  });

  test("another user's passkey is refused with an attempt counted, and the right one still works", async () => {
    const ada = await holder(A, "ada2@example.test");
    const bob = await holder(A, BOB);
    const challenge = await challengeFor(A, "ada2@example.test");

    const refused = await gql(A, CONFIRM_PASSKEY, {
      challenge: challenge.challenge,
      assertion: await assertion(A, bob, challenge.passkeyOptions),
    });
    expect(codeOf(refused)).toBe("CODE_INVALID");
    expect(refused.errors?.[0]?.extensions?.["attemptsLeft"]).toBe(4);
    expect(cookieOf(refused)).toBe("");

    const done = await gql(A, CONFIRM_PASSKEY, {
      challenge: challenge.challenge,
      assertion: await assertion(A, ada, challenge.passkeyOptions),
    });
    expect(done.errors).toBeUndefined();
    expect(at(done.data, "confirmSecondFactorWithPasskey.user.email")).toBe(
      "ada2@example.test",
    );
  });

  test("a challenge spent by the app's code is spent for a passkey too", async () => {
    const eve = await holder(A, "eve@example.test");
    const challenge = await challengeFor(A, "eve@example.test");
    const totp = await gql(A, CONFIRM_TOTP, {
      challenge: challenge.challenge,
      code: totpCode(eve.secret, new Date(Date.now() + 30_000)),
    });
    expect(totp.errors).toBeUndefined();
    const late = await gql(A, CONFIRM_PASSKEY, {
      challenge: challenge.challenge,
      assertion: await assertion(A, eve, challenge.passkeyOptions),
    });
    expect(codeOf(late)).toBe("TOKEN_SPENT");
    expect(cookieOf(late)).toBe("");
  });

  test("an expired challenge opens no session", async () => {
    const zoe = await holder(A, "zoe@example.test");
    const challenge = await challengeFor(A, "zoe@example.test");
    await oauthDb
      .collection("partitionedTokens")
      .updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const late = await gql(A, CONFIRM_PASSKEY, {
      challenge: challenge.challenge,
      assertion: await assertion(A, zoe, challenge.passkeyOptions),
    });
    expect(["TOKEN_EXPIRED", "TOKEN_UNKNOWN"]).toContain(
      defined(codeOf(late), "the refusal's code"),
    );
    expect(cookieOf(late)).toBe("");
  });

  test("a challenge and a passkey of tenant A open nothing on tenant B", async () => {
    const amy = await holder(A, "amy@example.test");
    const bea = await holder(B, "amy@example.test");
    const challenge = await challengeFor(A, "amy@example.test");

    // A's challenge, answered on B's host, even with B's own passkey.
    for (const who of [amy, bea]) {
      const refused = await gql(B, CONFIRM_PASSKEY, {
        challenge: challenge.challenge,
        assertion: await assertion(B, who, challenge.passkeyOptions),
      });
      expect(refused.errors).toBeDefined();
      expect(cookieOf(refused)).toBe("");
    }
    // It still answers on its own tenant.
    const done = await gql(A, CONFIRM_PASSKEY, {
      challenge: challenge.challenge,
      assertion: await assertion(A, amy, challenge.passkeyOptions),
    });
    expect(done.errors).toBeUndefined();
  });

  test("a tenant that turned passkeys off refuses the answer and keeps the challenge", async () => {
    const kim = await holder(A, "kim@example.test");
    const challenge = await challengeFor(A, "kim@example.test");
    const tenantId = (await tenantOf(A)).tenantId;
    await policies.updateMethods(tenantId, [
      { type: "passkey", enabled: false },
    ]);
    try {
      const refused = await gql(A, CONFIRM_PASSKEY, {
        challenge: challenge.challenge,
        assertion: await assertion(A, kim, challenge.passkeyOptions),
      });
      expect(codeOf(refused)).toBe("SIGN_IN_METHOD_DISABLED");
      expect(cookieOf(refused)).toBe("");
    } finally {
      await policies.updateMethods(tenantId, [
        { type: "passkey", enabled: true },
      ]);
    }
    const done = await gql(A, CONFIRM_PASSKEY, {
      challenge: challenge.challenge,
      assertion: await assertion(A, kim, challenge.passkeyOptions),
    });
    expect(done.errors).toBeUndefined();
  });
});
