import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { totpCode } from "@softistx/janus/testing";
import type { MemoryMailer } from "@softistx/mail";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { masterKeys } from "@/config/keys";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { janusIssuers } from "@/config/users";
import { settled } from "@/modules/auth";
import {
  resealAllTenants,
  resealExitCode,
  resealSecondFactorOf,
} from "@/modules/keys";
import {
  emptySecretResealCounts,
  SignInPolicyService,
} from "@/modules/sign-in-methods";
import { issuerOf, PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { SESSION_COOKIE, secondFactorKeysOf } from "@/modules/users";
import { createTestApp } from "~/app";
import { clientHeaders } from "~/client-header";

const memory = mailer as MemoryMailer;
const app = createTestApp();
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const policies = new SignInPolicyService(
  tenantsService,
  {
    seal: () => "",
    open: () => "",
  } as never,
  () => {},
);

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
      ...clientHeaders,
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

const REQUEST = `mutation ($email: EmailAddress!) {
  requestSignInCode(email: $email) { challenge }
}`;
const VERIFY = `mutation ($challenge: String!, $code: String!) {
  verifySignInCode(challenge: $challenge, code: $code) {
    __typename
    ... on SignedIn { expiresAt user { id email } }
    ... on SecondFactorChallenge { challenge methods passkeyOptions returnTo }
  }
}`;
const CONFIRM = `mutation ($challenge: String!, $code: String!) {
  confirmSecondFactor(challenge: $challenge, code: $code) {
    user { id email } newDevice recoveryCodesLeft
  }
}`;
const RECOVER = `mutation ($challenge: String!, $recoveryCode: String!) {
  recoverSecondFactor(challenge: $challenge, recoveryCode: $recoveryCode) {
    user { id } recoveryCodesLeft
  }
}`;
const ENROLL = "mutation { enrollSecondFactor { secret uri } }";
const ACTIVATE = `mutation ($code: String!) {
  activateSecondFactor(code: $code) { recoveryCodes }
}`;
const STATUS = "{ secondFactor { enabled recoveryCodesLeft } }";
const ME = "{ currentUser { id email } }";

const codeOf = (answer: Answer) => answer.errors?.[0]?.extensions?.["code"];
const cookieOf = (answer: Answer) => {
  const header = answer.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return header === undefined ? "" : (header.split(";")[0] ?? "");
};

/** Signs the address in by e-mailed code, as the hosted page does. */
async function signInByCode(slug: string, email: string) {
  const before = memory.sent.length;
  const asked = await gql(slug, REQUEST, { email });
  await settled();
  const challenge = asked.data?.["requestSignInCode"].challenge as string;
  const mail = memory.sent
    .slice(before)
    .filter((m) => JSON.stringify(m.to).includes(email))
    .at(-1);
  const code = /\b(\d{6})\b/.exec(mail?.text ?? "")?.[1] ?? "";
  return gql(slug, VERIFY, { challenge, code });
}

/** The `amr` janus reads off the session of `cookie`. */
async function amrOf(slug: string, cookie: string) {
  const current = (await janusOf(slug)).authenticate(
    new Request(url(slug), { headers: { cookie } }),
  );
  return [...((await current)?.session.amr ?? [])];
}

/** A signed-in user (session cookie) of the tenant. */
async function sessionOf(slug: string, email: string) {
  const answer = await signInByCode(slug, email);
  expect(answer.data?.["verifySignInCode"].__typename).toBe("SignedIn");
  return {
    cookie: cookieOf(answer),
    id: answer.data?.["verifySignInCode"].user.id as string,
  };
}

/** Turns on TOTP for the tenant. */
async function offerTotp(slug: string, totp = true) {
  const tenant = await tenantOf(slug);
  await policies.updateMfa(tenant.tenantId, { totp });
}

/** Enrols and activates TOTP for a signed-in user; the secret and the recovery codes. */
async function turnOn(slug: string, cookie: string) {
  const enrolled = await gql(slug, ENROLL, {}, cookie);
  const secret = enrolled.data?.["enrollSecondFactor"].secret as string;
  const activated = await gql(
    slug,
    ACTIVATE,
    { code: totpCode(secret) },
    cookie,
  );
  return {
    secret,
    recoveryCodes: activated.data?.["activateSecondFactor"]
      .recoveryCodes as string[],
    enrolled,
    activated,
  };
}

const ADA = "ada@example.test";
const BOB = "bob@example.test";
const SLUGS = { a: "acme", b: "globex" };

beforeAll(async () => {
  await tenantsService.create({ slug: SLUGS.a, name: "Acme", signUp: true });
  await tenantsService.create({ slug: SLUGS.b, name: "Globex", signUp: true });
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

describe("the tenant's policy", () => {
  test("TOTP is off by default: enrolment is refused, and nothing was started", async () => {
    const { cookie } = await sessionOf(SLUGS.a, "off@example.test");
    const refused = await gql(SLUGS.a, ENROLL, {}, cookie);
    expect(codeOf(refused)).toBe("SECOND_FACTOR_DISABLED");
    expect(refused.status).toBe(403);
    expect(
      (await gql(SLUGS.a, STATUS, {}, cookie)).data?.["secondFactor"],
    ).toEqual({ enabled: false, recoveryCodesLeft: null });
  });

  test("activation is refused too while TOTP is off", async () => {
    const { cookie } = await sessionOf(SLUGS.a, "off2@example.test");
    const refused = await gql(SLUGS.a, ACTIVATE, { code: "000000" }, cookie);
    expect(codeOf(refused)).toBe("SECOND_FACTOR_DISABLED");
  });

  test("an anonymous request has no second factor", async () => {
    await offerTotp(SLUGS.a);
    expect(codeOf(await gql(SLUGS.a, STATUS))).toBe("UNAUTHENTICATED");
    expect(codeOf(await gql(SLUGS.a, ENROLL))).toBe("UNAUTHENTICATED");
  });
});

describe("enrol, activate, sign in with the challenge", () => {
  test("a user turns on TOTP, is asked for it at the next sign-in by code, and confirms it", async () => {
    await offerTotp(SLUGS.a);
    const { cookie } = await sessionOf(SLUGS.a, ADA);
    const on = await turnOn(SLUGS.a, cookie);
    expect(on.enrolled.data?.["enrollSecondFactor"].uri).toStartWith(
      "otpauth://totp/",
    );
    expect(on.recoveryCodes).toHaveLength(10);
    expect(
      (await gql(SLUGS.a, STATUS, {}, cookie)).data?.["secondFactor"],
    ).toEqual({ enabled: true, recoveryCodesLeft: 10 });

    // Next sign-in: a challenge, no session.
    const stopped = await signInByCode(SLUGS.a, ADA);
    const challenge = stopped.data?.["verifySignInCode"];
    expect(challenge.__typename).toBe("SecondFactorChallenge");
    expect(challenge.methods).toContain("totp");
    expect(cookieOf(stopped)).toBe("");

    // A wrong code is refused, the right one opens the session.
    const wrong = await gql(SLUGS.a, CONFIRM, {
      challenge: challenge.challenge,
      code: "000000",
    });
    expect(codeOf(wrong)).toBe("CODE_INVALID");
    const confirmed = await gql(SLUGS.a, CONFIRM, {
      challenge: challenge.challenge,
      code: totpCode(on.secret, new Date(Date.now() + 30_000)),
    });
    expect(confirmed.errors).toBeUndefined();
    expect(confirmed.data?.["confirmSecondFactor"].user.email).toBe(ADA);
    const session = cookieOf(confirmed);
    expect(session).not.toBe("");
    expect(
      (await gql(SLUGS.a, ME, {}, session)).data?.["currentUser"].email,
    ).toBe(ADA);
    // RFC 8176: an authenticator code is `otp`, with `mfa` (nxgt-janus#950).
    const proved = await amrOf(SLUGS.a, session);
    expect(proved).toEqual(expect.arrayContaining(["otp", "mfa"]));
    expect(proved).not.toContain("rec");
  });

  test("a recovery code answers the challenge once", async () => {
    const { cookie } = await sessionOf(SLUGS.a, "rec@example.test");
    const on = await turnOn(SLUGS.a, cookie);
    const stopped = await signInByCode(SLUGS.a, "rec@example.test");
    const challenge = stopped.data?.["verifySignInCode"].challenge as string;
    const code = on.recoveryCodes[0] as string;
    const recovered = await gql(SLUGS.a, RECOVER, {
      challenge,
      recoveryCode: code,
    });
    expect(recovered.data?.["recoverSecondFactor"].recoveryCodesLeft).toBe(9);
    expect(cookieOf(recovered)).not.toBe("");
    // RFC 8176: a recovery code is `rec` with `mfa` (janus 0.77): the session
    // says which second factor opened it. `otp` stays: it is the first factor
    // here (the email sign-in code), merged with the second factor's amr.
    const proved = await amrOf(SLUGS.a, cookieOf(recovered));
    expect(proved).toContain("rec");
    expect(proved).toContain("mfa");

    const again = await signInByCode(SLUGS.a, "rec@example.test");
    const next = again.data?.["verifySignInCode"].challenge as string;
    expect(
      codeOf(
        await gql(SLUGS.a, RECOVER, { challenge: next, recoveryCode: code }),
      ),
    ).toBeDefined();
  });

  test("a tenant that turned TOTP off again keeps the factor of those who hold one, and refuses new ones", async () => {
    await offerTotp(SLUGS.a);
    const { cookie } = await sessionOf(SLUGS.a, "keep@example.test");
    await turnOn(SLUGS.a, cookie);
    await offerTotp(SLUGS.a, false);
    const stopped = await signInByCode(SLUGS.a, "keep@example.test");
    expect(stopped.data?.["verifySignInCode"].__typename).toBe(
      "SecondFactorChallenge",
    );
    const { cookie: other } = await sessionOf(SLUGS.a, "late@example.test");
    expect(codeOf(await gql(SLUGS.a, ENROLL, {}, other))).toBe(
      "SECOND_FACTOR_DISABLED",
    );
    await offerTotp(SLUGS.a);
  });
});

describe("reset by an admin", () => {
  test("the console's reset removes the factor: the next sign-in opens a session", async () => {
    await offerTotp(SLUGS.a);
    const { cookie, id } = await sessionOf(SLUGS.a, "lost@example.test");
    await turnOn(SLUGS.a, cookie);
    const tenant = await tenantOf(SLUGS.a);
    const auth = await janusOf(SLUGS.a);
    const user = await auth.findUser(id);
    expect(user?.hasSecondFactor).toBe(true);
    // The console's port (`ConsoleUsers.resetSecondFactor`) is exercised through its pool.
    const { UsersService } = await import("@/modules/users");
    const users = new UsersService({
      janusOf: async () => auth,
      grantsOf: async () => {
        throw new Error("not used");
      },
      invitationsOf: () => {
        throw new Error("not used");
      },
    });
    expect(await users.secondFactor(tenant.tenantId, id)).toEqual({
      enabled: true,
      recoveryCodesLeft: 10,
    });
    expect(await users.resetSecondFactor(tenant.tenantId, id)).not.toBeNull();
    expect(await users.secondFactor(tenant.tenantId, id)).toEqual({
      enabled: false,
      recoveryCodesLeft: null,
    });
    const answer = await signInByCode(SLUGS.a, "lost@example.test");
    expect(answer.data?.["verifySignInCode"].__typename).toBe("SignedIn");
    expect(await users.resetSecondFactor(tenant.tenantId, "nobody")).toBeNull();
  });
});

describe("a keyring rotation", () => {
  test("a new first key: keys:reseal seals the secrets under it (janus secondFactor.reseal)", async () => {
    await offerTotp(SLUGS.a);
    const { cookie } = await sessionOf(SLUGS.a, "rot@example.test");
    await turnOn(SLUGS.a, cookie);

    const tenant = await tenantOf(SLUGS.a);
    const newMaster = new Uint8Array(32).fill(9);
    const ring = [newMaster, ...masterKeys] as [Uint8Array, ...Uint8Array[]];
    // The tenant's own sealed stores are another spec's (src/modules/keys/keys.reseal.spec.ts).
    const none = async () => emptySecretResealCounts();
    const noStores = {
      webhookSecrets: none,
      connectionSecrets: none,
      socialSecrets: none,
    };
    const report = await resealAllTenants({
      db: mongo.db as never,
      masterKeys: ring,
      resealSecondFactor: resealSecondFactorOf(
        mongo.db as never,
        secondFactorKeysOf(ring),
      ),
      tenantIds: async () => [tenant.partition],
      log: () => {},
      secretStores: noStores,
    });
    // The secret moved under the new first key, whoever signs in; the ten
    // recovery codes are hashes, they keep the old key until new ones are issued.
    expect(report.secondFactor.resealed).toBeGreaterThanOrEqual(1);
    expect(report.secondFactor.unreadable).toBe(0);
    expect(report.secondFactor.behind).toBe(0);
    expect(report.secondFactor.recoveryCodesBehind).toBeGreaterThanOrEqual(10);
    expect(secondFactorKeysOf(ring)).toHaveLength(masterKeys.length + 1);

    // Idempotent: a second pass has nothing to seal again.
    const again = await resealAllTenants({
      db: mongo.db as never,
      masterKeys: ring,
      resealSecondFactor: resealSecondFactorOf(
        mongo.db as never,
        secondFactorKeysOf(ring),
      ),
      tenantIds: async () => [tenant.partition],
      log: () => {},
      secretStores: noStores,
    });
    expect(again.secondFactor).toMatchObject({ resealed: 0, skipped: 0 });
    expect(resealExitCode(again)).toBe(0);

    // The stored secret is now sealed under the new first key.
    const stored = await mongo.db
      .collection<{ secondFactor?: { secret?: string } }>("partitionedUsers")
      .findOne({
        partition: tenant.partition,
        "secondFactor.secret": { $exists: true },
      });
    expect(stored?.secondFactor?.secret?.split(".")[1]).toBe(
      secondFactorKeysOf(ring)[0].id,
    );
  });
});

describe("tenants are isolated", () => {
  test("a factor of tenant A does not exist on tenant B, and A's session does not read B", async () => {
    await offerTotp(SLUGS.a);
    await offerTotp(SLUGS.b, false);
    const a = await sessionOf(SLUGS.a, BOB);
    const aOn = await turnOn(SLUGS.a, a.cookie);
    expect(aOn.recoveryCodes).toHaveLength(10);

    // The same address on B is another user, with no factor.
    const b = await signInByCode(SLUGS.b, BOB);
    expect(b.data?.["verifySignInCode"].__typename).toBe("SignedIn");
    // A's cookie says nothing on B.
    expect(codeOf(await gql(SLUGS.b, STATUS, {}, a.cookie))).toBe(
      "UNAUTHENTICATED",
    );
    // B's TOTP being off blocks B's enrolment only.
    const bSession = cookieOf(b);
    const enrolB = await gql(SLUGS.b, ENROLL, {}, bSession);
    expect(codeOf(enrolB)).toBe("SECOND_FACTOR_DISABLED");
    expect(
      (await gql(SLUGS.a, STATUS, {}, a.cookie)).data?.["secondFactor"].enabled,
    ).toBe(true);
  });
});

describe("an unknown host", () => {
  test("is NOT_FOUND on the second-factor operations", async () => {
    const host = `http://nobody-here.${env.CLAVIX_DOMAIN}`;
    const response = await app.request(`${host}/graphql`, {
      method: "POST",
      headers: {
        ...clientHeaders,
        "content-type": "application/json",
        origin: host,
      },
      body: JSON.stringify({ query: "{ secondFactor { enabled } }" }),
    });
    const body = (await response.json()) as {
      errors?: { extensions: Record<string, unknown> }[];
    };
    expect(body.errors?.[0]?.extensions["code"]).toBe("NOT_FOUND");
  });
});
