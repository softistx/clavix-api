import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mongo } from "@/config/db";
import { mailer } from "@/config/mail";
import { tenantsService } from "@/config/tenancy";
import { CHANGE_EMAIL_PATH } from "@/mail/tenant-mail";
import { settled } from "@/modules/auth/auth.outbox";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import {
  ageSessions,
  clearJanus,
  codeOf,
  gql,
  hostOf,
  janusOf,
  signedIn,
} from "~/account-session";
import { memoryMailerOf } from "~/memory-mailer-of";
import { createTenantParOff } from "~/tenant-par-off";

const SLUG = "acct-email";
const REQUEST = `mutation ($email: EmailAddress!) { requestEmailChange(email: $email) }`;
const CONFIRM = `mutation ($token: String!) { confirmEmailChange(token: $token) { id email emailVerified } }`;
const memory = memoryMailerOf(mailer);

const hasTo = (mail: (typeof memory.sent)[number], email: string) =>
  JSON.stringify(mail.to).includes(email);

// The change link mailed to `email` since `before`, and its token.
function linkTo(email: string, before: number) {
  const mails = memory.sent.slice(before).filter((m) => hasTo(m, email));
  const link = /https?:\/\/[^\s"'<>]+\/account\/email\?token=[\w-]+/.exec(
    mails.at(-1)?.text ?? "",
  )?.[0];
  const token =
    link === undefined ? undefined : new URL(link).searchParams.get("token");
  return { mails, link, token: token ?? "" };
}

let counter = 0;
const fresh = () => {
  counter += 1;
  return `moved${counter}@example.test`;
};

async function ask(session: { cookie: string }, email: string) {
  const before = memory.sent.length;
  const answer = await gql(SLUG, REQUEST, { email }, session.cookie);
  await settled();
  return { answer, ...linkTo(email, before) };
}

beforeAll(async () => {
  await createTenantParOff(tenantsService, {
    slug: SLUG,
    name: SLUG,
    signUp: true,
  });
}, 300_000);

afterAll(async () => {
  await settled();
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await clearJanus();
});

describe("requestEmailChange", () => {
  test("mails the NEW address a link to the hosted page and changes nothing yet", async () => {
    const me = await signedIn(SLUG);
    const target = fresh();
    const { answer, mails, link } = await ask(me, target);
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ requestEmailChange: true });
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(mails).toHaveLength(1);
    expect(link).toStartWith(`${hostOf(SLUG)}${CHANGE_EMAIL_PATH}?token=`);
    expect((await (await janusOf(SLUG)).findUser(me.user.id))?.email).toBe(
      me.user.email,
    );
  });

  test("is 401 anonymous and STEP_UP_REQUIRED (403) on a session older than ten minutes", async () => {
    expect(codeOf(await gql(SLUG, REQUEST, { email: fresh() }))).toBe(
      "UNAUTHENTICATED",
    );
    const me = await signedIn(SLUG);
    await ageSessions(me.user.id);
    const before = memory.sent.length;
    const stale = await gql(SLUG, REQUEST, { email: fresh() }, me.cookie);
    await settled();
    expect(stale.status).toBe(403);
    expect(codeOf(stale)).toBe("STEP_UP_REQUIRED");
    expect(memory.sent.length).toBe(before);
  });

  test("the current address is refused as BAD_USER_INPUT", async () => {
    const me = await signedIn(SLUG);
    const same = await gql(SLUG, REQUEST, { email: me.user.email }, me.cookie);
    expect(same.status).toBe(400);
    expect(codeOf(same)).toBe("BAD_USER_INPUT");
  });

  test("asking again and again for one address is MAIL_THROTTLED, 429, with retryAfter", async () => {
    const me = await signedIn(SLUG);
    const target = fresh();
    let refused = await ask(me, target);
    for (let i = 0; i < 30 && refused.answer.status === 200; i += 1) {
      refused = await ask(me, target);
    }
    expect(refused.answer.status).toBe(429);
    expect(codeOf(refused.answer)).toBe("MAIL_THROTTLED");
    expect(
      refused.answer.errors?.[0]?.extensions?.["retryAfter"],
    ).toBeGreaterThan(0);
  });
});

describe("confirmEmailChange", () => {
  test("moves the account, marks it verified, keeps the session and tells the former address", async () => {
    const me = await signedIn(SLUG);
    const target = fresh();
    const { token } = await ask(me, target);
    const before = memory.sent.length;
    const done = await gql(SLUG, CONFIRM, { token }, me.cookie);
    await settled();
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({
      confirmEmailChange: {
        id: me.user.id,
        email: target,
        emailVerified: true,
      },
    });
    const stored = await (await janusOf(SLUG)).findUser(me.user.id);
    expect(stored?.email).toBe(target);
    const notice = memory.sent
      .slice(before)
      .filter((m) => hasTo(m, me.user.email));
    expect(notice).toHaveLength(1);
    const still = await gql(SLUG, `{ currentUser { email } }`, {}, me.cookie);
    expect(still.data).toMatchObject({ currentUser: { email: target } });
    const spent = await gql(SLUG, CONFIRM, { token }, me.cookie);
    expect(codeOf(spent)).toBe("EMAIL_CHANGE_INVALID");
  });

  test("is LOGIN_TAKEN (409) when another account took the address meanwhile", async () => {
    const me = await signedIn(SLUG);
    const target = fresh();
    const { token } = await ask(me, target);
    await signedIn(SLUG, target);
    const taken = await gql(SLUG, CONFIRM, { token }, me.cookie);
    expect(taken.status).toBe(409);
    expect(codeOf(taken)).toBe("LOGIN_TAKEN");
    expect((await (await janusOf(SLUG)).findUser(me.user.id))?.email).toBe(
      me.user.email,
    );
  });

  test("an unknown token is EMAIL_CHANGE_INVALID (400) and an anonymous call is 401", async () => {
    const me = await signedIn(SLUG);
    const unknown = await gql(SLUG, CONFIRM, { token: "nope" }, me.cookie);
    expect(unknown.status).toBe(400);
    expect(codeOf(unknown)).toBe("EMAIL_CHANGE_INVALID");
    expect(codeOf(await gql(SLUG, CONFIRM, { token: "nope" }))).toBe(
      "UNAUTHENTICATED",
    );
  });

  test("a token of another account is a bearer proof: it moves its owner, the session answers its own user", async () => {
    const owner = await signedIn(SLUG);
    const other = await signedIn(SLUG);
    const target = fresh();
    const { token } = await ask(owner, target);
    const done = await gql(SLUG, CONFIRM, { token }, other.cookie);
    await settled();
    expect(done.data).toMatchObject({
      confirmEmailChange: { id: other.user.id, email: other.user.email },
    });
    expect((await (await janusOf(SLUG)).findUser(owner.user.id))?.email).toBe(
      target,
    );
  });
});
