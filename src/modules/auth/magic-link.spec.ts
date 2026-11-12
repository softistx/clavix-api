import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MemoryMailer } from "@softistx/mail";
import { createApp } from "@/app";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver } from "@/config/tenancy";
import { janusIssuers } from "@/config/users";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { TenantsService } from "@/modules/tenants/tenants.service";
import { MAGIC_LINK_LIFESPAN, SESSION_COOKIE } from "@/users/tenant-janus";
import { settled } from "./outbox";

// The flag is read once at start: `bun run test` runs the "on" half with
// CLAVIX_MAGIC_LINK=true and the "off" half (the default) in the main pass.
const on = env.CLAVIX_MAGIC_LINK;
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
): Promise<Answer> {
  const response = await app.request(url(slug), {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
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
  confirmMagicLink(token: $token) { expiresAt user { id email emailVerified } }
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
  await service.create({ slug: "acme", name: "Acme", signUp: true });
  await service.create({ slug: "vault", name: "Vault" }); // closed
});
afterAll(cleanup);

describe.skipIf(on)("magic link switched off (the default)", () => {
  test("requestMagicLink is 404 MAGIC_LINK_DISABLED and sends nothing", async () => {
    const before = memory.sent.length;
    const { answer, mails } = await ask("acme", "ada@example.test");
    expect(answer.status).toBe(404);
    expect(codeOf(answer)).toBe("MAGIC_LINK_DISABLED");
    expect(mails).toHaveLength(0);
    expect(memory.sent.length).toBe(before);
  });

  test("confirmMagicLink is 404 MAGIC_LINK_DISABLED, whatever the token", async () => {
    const answer = await gql("acme", CONFIRM, { token: "anything" });
    expect(answer.status).toBe(404);
    expect(codeOf(answer)).toBe("MAGIC_LINK_DISABLED");
    expect(answer.cookies).toHaveLength(0);
  });

  test("nothing is created", async () => {
    await gql("acme", REQUEST, { email: "ghost@example.test" });
    const users = await oauthDb
      .collection("partitionedUsers")
      .countDocuments({ email: "ghost@example.test" } as never);
    expect(users).toBe(0);
  });
});

describe.skipIf(!on)("magic link switched on", () => {
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
    await service.create({ slug: "globex", name: "Globex", signUp: true });
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
