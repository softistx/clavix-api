import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MemoryMailer } from "@softistx/mail";
import { createApp } from "@/app";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { secretBox } from "@/config/keys";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver } from "@/config/tenancy";
import { janusIssuers } from "@/config/users";
import { SignInPolicyService } from "@/modules/sign-in-methods/service";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { TenantsService } from "@/modules/tenants/tenants.service";
import { MAGIC_LINK_LIFESPAN, SESSION_COOKIE } from "@/users/tenant-janus";
import { settled } from "./outbox";

// Magic link is the tenant's choice, off until it turns it on (its sign-in
// policy, slice A5): "plain" never did, "acme" and "vault" did.
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
  ip = "198.51.100.7",
  extra: Record<string, string> = {},
): Promise<Answer> {
  const response = await app.request(url(slug), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...extra,
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
  requestMagicLink(email: $email) { expiresAt }
}`;
const CONFIRM = `mutation ($token: String!) {
  confirmMagicLink(token: $token) { ... on SignedIn { expiresAt user { id email emailVerified } } }
}`;
const ME = "{ currentUser { email emailVerified } }";
const codeOf = (answer: Answer) => answer.errors?.[0]?.extensions?.["code"];

const hasTo = (mail: (typeof memory.sent)[number], email: string) =>
  JSON.stringify(mail.to).includes(email);

// The link mailed to an address (if any), and the token in it.
async function ask(slug: string, email: string, ip?: string) {
  const before = memory.sent.length;
  const answer = await gql(slug, REQUEST, { email }, ip);
  await settled();
  const mails = memory.sent.slice(before).filter((m) => hasTo(m, email));
  const link = /https?:\/\/[^\s"'<>]+\/sign-in\/link\?token=[\w-]+/.exec(
    mails.at(-1)?.text ?? "",
  )?.[0];
  const token =
    link === undefined ? undefined : new URL(link).searchParams.get("token");
  return { answer, mails, link, token: token ?? "" };
}

const cleanup = async () => {
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
};

beforeAll(async () => {
  // "plain" never turned magic link on (the default); "acme" and "vault" did.
  await service.create({ slug: "plain", name: "Plain", signUp: true });
  for (const [slug, signUp] of [
    ["acme", true],
    ["vault", false], // closed
  ] as const) {
    const created = await service.create({ slug, name: slug, signUp });
    await policy.updateMethods(created._id.toHexString(), [
      { type: "magicLink", enabled: true },
    ]);
  }
});
afterAll(cleanup);

describe("magic link off for a tenant that did not turn it on", () => {
  test("requestMagicLink is 404 MAGIC_LINK_DISABLED and sends nothing", async () => {
    const before = memory.sent.length;
    const { answer, mails } = await ask("plain", "ada@example.test");
    expect(answer.status).toBe(404);
    expect(codeOf(answer)).toBe("MAGIC_LINK_DISABLED");
    expect(mails).toHaveLength(0);
    expect(memory.sent.length).toBe(before);
  });

  test("confirmMagicLink is 404 MAGIC_LINK_DISABLED, whatever the token", async () => {
    const answer = await gql("plain", CONFIRM, { token: "anything" });
    expect(answer.status).toBe(404);
    expect(codeOf(answer)).toBe("MAGIC_LINK_DISABLED");
    expect(answer.cookies).toHaveLength(0);
  });

  test("nothing is created", async () => {
    await gql("plain", REQUEST, { email: "ghost@example.test" });
    const users = await oauthDb
      .collection("partitionedUsers")
      .countDocuments({ email: "ghost@example.test" } as never);
    expect(users).toBe(0);
  });
});

describe("magic link turned on by the tenant", () => {
  test("request mails a link, confirm opens the session and proves the e-mail", async () => {
    const { answer, link, token, mails } = await ask(
      "acme",
      "lin@example.test",
    );
    expect(answer.status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(link).toStartWith(`${issuerOf("acme", origin)}/sign-in/link?token=`);
    const requested = answer.data?.["requestMagicLink"] as
      | { expiresAt: string }
      | undefined;
    const left = new Date(requested?.expiresAt ?? 0).getTime();
    expect(left - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(MAGIC_LINK_LIFESPAN).toBe("15m");

    const signedIn = await gql("acme", CONFIRM, { token });
    expect(signedIn.status).toBe(200);
    const confirmed = signedIn.data?.["confirmMagicLink"] as
      | { user: { email: string; emailVerified: boolean } }
      | undefined;
    expect(confirmed?.user).toMatchObject({
      email: "lin@example.test",
      emailVerified: true,
    });
    const cookie = signedIn.cookies.find((c) =>
      c.startsWith(`${SESSION_COOKIE}=`),
    );
    expect(cookie).toBeDefined();
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");

    const me = await app.request(url("acme"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: (cookie ?? "").split(";")[0] ?? "",
      },
      body: JSON.stringify({ query: ME }),
    });
    expect(((await me.json()) as { data: unknown }).data).toEqual({
      currentUser: { email: "lin@example.test", emailVerified: true },
    });
  });

  test("the session records the User-Agent as its device label", async () => {
    const { token } = await ask("acme", "dev-link@example.test");
    const agent = "Mozilla/5.0 (Macintosh) Safari/605.1";
    const signedIn = await gql("acme", CONFIRM, { token }, undefined, {
      "user-agent": agent,
    });
    const confirmed = signedIn.data?.["confirmMagicLink"] as {
      user: { id: string };
    };
    const auth = await janusIssuers.forRequest(new Request(url("acme")));
    const id = confirmed.user.id;
    expect(
      (await auth?.sessions.list({ id }))?.map((session) => session.device),
    ).toEqual([agent]);
  });

  test("a link works once: the second confirm is MAGIC_LINK_INVALID, 401", async () => {
    const { token } = await ask("acme", "once@example.test");
    expect((await gql("acme", CONFIRM, { token })).status).toBe(200);
    const again = await gql("acme", CONFIRM, { token });
    expect(again.status).toBe(401);
    expect(codeOf(again)).toBe("MAGIC_LINK_INVALID");
    expect(again.cookies).toHaveLength(0);
  });

  test("an unknown token is the same MAGIC_LINK_INVALID", async () => {
    const answer = await gql("acme", CONFIRM, { token: "nope" });
    expect(answer.status).toBe(401);
    expect(codeOf(answer)).toBe("MAGIC_LINK_INVALID");
  });

  test("only the last link of a user works", async () => {
    const first = await ask("acme", "twice@example.test");
    const second = await ask("acme", "twice@example.test");
    expect(codeOf(await gql("acme", CONFIRM, { token: first.token }))).toBe(
      "MAGIC_LINK_INVALID",
    );
    expect((await gql("acme", CONFIRM, { token: second.token })).status).toBe(
      200,
    );
  });

  test("a closed tenant answers an unknown address alike and mails nothing", async () => {
    const auth = await (async () => {
      const found = await janusIssuers.forRequest(new Request(url("vault")));
      if (found === null) throw new Error("no janus for vault");
      return found;
    })();
    await auth.create({ email: "known@example.test" });
    const known = await ask("vault", "known@example.test");
    const unknown = await ask("vault", "stranger@example.test");
    expect(known.mails).toHaveLength(1);
    expect(unknown.mails).toHaveLength(0);
    expect(unknown.answer.status).toBe(known.answer.status);
    // Same shape; only the expiry instant differs.
    expect(Object.keys(unknown.answer.data ?? {})).toEqual(
      Object.keys(known.answer.data ?? {}),
    );
    expect(unknown.answer.errors).toBeUndefined();
    const users = await oauthDb
      .collection("partitionedUsers")
      .countDocuments({ email: "stranger@example.test" } as never);
    expect(users).toBe(0);
  });

  test("a link of tenant A is refused on tenant B", async () => {
    const globex = await service.create({
      slug: "globex",
      name: "Globex",
      signUp: true,
    });
    await policy.updateMethods(globex._id.toHexString(), [
      { type: "magicLink", enabled: true },
    ]);
    const { token } = await ask("acme", "iso@example.test");
    const answer = await gql("globex", CONFIRM, { token });
    expect(codeOf(answer)).toBe("MAGIC_LINK_INVALID");
  });

  test("a sixth request for one address in the window is MAIL_THROTTLED, 429", async () => {
    for (let i = 0; i < 5; i++) await ask("acme", "flood@example.test");
    const sixth = await gql("acme", REQUEST, { email: "flood@example.test" });
    expect(sixth.status).toBe(429);
    expect(codeOf(sixth)).toBe("MAIL_THROTTLED");
  });

  test("an unknown host is NOT_FOUND", async () => {
    const response = await app.request(
      `https://nobody.${env.CLAVIX_DOMAIN}/graphql`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: REQUEST,
          variables: { email: "a@example.test" },
        }),
      },
    );
    expect(response.status).toBe(404);
  });

  test("the tenant's janus reports the switch on", async () => {
    const auth = await janusIssuers.forRequest(new Request(url("acme")));
    expect(auth?.magicLink.enabled).toBe(true);
  });
});
