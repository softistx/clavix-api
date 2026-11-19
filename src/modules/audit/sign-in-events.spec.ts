import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { MemoryMailer } from "@softistx/mail";
import { createApp } from "@/app";
import { authEventsService } from "@/config/audit";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { secretBox } from "@/config/keys";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver } from "@/config/tenancy";
import { settled } from "@/modules/auth/outbox";
import { SignInPolicyService } from "@/modules/sign-in-methods/service";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { TenantsService } from "@/modules/tenants/tenants.service";
import { SESSION_COOKIE } from "@/users/tenant-janus";

// Each hosted sign-in source writes exactly one event (D12, D14), and a
// recorder that is down never fails the sign-in (D13).
const memory = mailer as MemoryMailer;
const app = createApp();
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const service = new TenantsService(mongo.db.tenants, {
  onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
});
const policy = new SignInPolicyService(service, secretBox);
const url = (slug: string) => `${issuerOf(slug, origin)}/graphql`;

async function gql(
  slug: string,
  query: string,
  variables: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const response = await app.request(url(slug), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.9",
      "user-agent": "Mozilla/5.0 Firefox/130.0",
      ...headers,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as {
    data?: Record<string, unknown> | null;
    errors?: { extensions?: { code?: string } }[];
  };
  return { body, cookies: response.headers.getSetCookie() };
}

const REQUEST_CODE = `mutation ($email: EmailAddress!) { requestSignInCode(email: $email) { challenge } }`;
const VERIFY = `mutation ($challenge: String!, $code: String!) { verifySignInCode(challenge: $challenge, code: $code) { ... on SignedIn { user { id } } } }`;
const REQUEST_LINK = `mutation ($email: EmailAddress!) { requestMagicLink(email: $email) { expiresAt } }`;
const CONFIRM = `mutation ($token: String!) { confirmMagicLink(token: $token) { ... on SignedIn { user { id } } } }`;
const SIGN_OUT = "mutation { signOut }";

async function codeFor(slug: string, email: string) {
  const before = memory.sent.length;
  const asked = await gql(slug, REQUEST_CODE, { email });
  await settled();
  const mail = memory.sent
    .slice(before)
    .filter((m) => JSON.stringify(m.to).includes(email))
    .at(-1);
  return {
    challenge:
      (
        (asked.body.data?.["requestSignInCode"] ?? {}) as {
          challenge?: string;
        }
      ).challenge ?? "",
    code: /\b(\d{6})\b/.exec(mail?.text ?? "")?.[1] ?? "",
  };
}

let tenant = "";
const events = async () =>
  (await authEventsService.page(tenant, {}, { after: null, limit: 50 })).items;

beforeAll(async () => {
  const created = await service.create({
    slug: "sie",
    name: "Sie",
    signUp: true,
  });
  tenant = created._id.toHexString();
  await policy.updateMethods(tenant, [{ type: "magicLink", enabled: true }]);
});
afterAll(async () => {
  await settled();
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.authEvents.raw.deleteMany({});
  for (const name of ["partitionedUsers", "partitionedSessions"]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

describe("the e-mail code", () => {
  test("a sign-in writes one success, a sign-out one more", async () => {
    const { challenge, code } = await codeFor("sie", "ada@example.test");
    const signedIn = await gql("sie", VERIFY, { challenge, code });
    expect(signedIn.body.errors).toBeUndefined();
    const cookie =
      signedIn.cookies
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
        ?.split(";")[0] ?? "";
    const userId =
      (
        (signedIn.body.data?.["verifySignInCode"] ?? {}) as {
          user?: { id: string };
        }
      ).user?.id ?? "";

    const [signIn] = await events();
    expect(await events()).toHaveLength(1);
    expect(signIn).toMatchObject({
      type: "session.signIn",
      outcome: "success",
      method: "emailCode",
      userId,
      actor: { kind: "user", id: userId },
      ip: "198.51.100.9",
      userAgent: "Firefox",
    });
    expect(signIn?.requestId).toBeString();

    await gql("sie", SIGN_OUT, {}, { cookie });
    const after = await events();
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ type: "session.signOut", userId });
  });

  test("a wrong code writes one failure with its reason and no user", async () => {
    await mongo.db.authEvents.raw.deleteMany({});
    const { challenge } = await codeFor("sie", "grace@example.test");
    const wrong = await gql("sie", VERIFY, { challenge, code: "000000" });
    expect(wrong.body.errors?.[0]?.extensions?.code).toBe("CODE_INVALID");
    const all = await events();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      type: "session.signIn",
      outcome: "failure",
      reason: "CODE_INVALID",
      method: "emailCode",
      actor: { kind: "user", id: "anonymous" },
    });
  });

  test("a signed-out call that was not signed in writes nothing", async () => {
    await mongo.db.authEvents.raw.deleteMany({});
    await gql("sie", SIGN_OUT);
    expect(await events()).toHaveLength(0);
  });
});

describe("the magic link", () => {
  test("confirming it writes one success by magicLink", async () => {
    await mongo.db.authEvents.raw.deleteMany({});
    const before = memory.sent.length;
    await gql("sie", REQUEST_LINK, { email: "lin@example.test" });
    await settled();
    const text = memory.sent
      .slice(before)
      .filter((m) => JSON.stringify(m.to).includes("lin@example.test"))
      .at(-1)?.text;
    const link = /https?:\/\/[^\s"'<>]+\/sign-in\/link\?token=[\w-]+/.exec(
      text ?? "",
    )?.[0];
    const token = new URL(link ?? "http://x").searchParams.get("token") ?? "";
    const done = await gql("sie", CONFIRM, { token });
    expect(done.body.errors).toBeUndefined();
    const all = await events();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      type: "session.signIn",
      outcome: "success",
      method: "magicLink",
    });
  });
});

describe("a recorder that is down", () => {
  test("the sign-in still succeeds and nothing is written", async () => {
    await mongo.db.authEvents.raw.deleteMany({});
    const broken = spyOn(authEventsService, "record").mockRejectedValue(
      new Error("mongo down"),
    );
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    const { challenge, code } = await codeFor("sie", "kay@example.test");
    const signedIn = await gql("sie", VERIFY, { challenge, code });
    broken.mockRestore();
    quiet.mockRestore();
    expect(signedIn.body.errors).toBeUndefined();
    expect(signedIn.cookies.some((c) => c.startsWith(SESSION_COOKIE))).toBe(
      true,
    );
    expect(await events()).toHaveLength(0);
  });
});
