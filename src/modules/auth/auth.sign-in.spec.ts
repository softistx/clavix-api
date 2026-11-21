import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import type { MemoryMailer } from "@softistx/mail";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver } from "@/config/tenancy";
import { janusIssuers } from "@/config/users";
import {
  issuerOf,
  PLATFORM_TENANT_SLUG,
  TenantsService,
} from "@/modules/tenants";
import { SESSION_COOKIE, SIGN_IN_CODE_LIFESPAN } from "@/modules/users";
import { createTestApp } from "~/app";
import { clientHeaders } from "~/client-header";
import { quietTenants } from "~/ports";
import { afterAnswer, settled } from "./auth.outbox";

const memory = mailer as MemoryMailer;
const app = createTestApp();
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const service = new TenantsService(mongo.db.tenants, {
  ...quietTenants,
  now: () => new Date(),
  log: () => {},
  onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
});

const url = (slug: string) => `${issuerOf(slug, origin)}/graphql`;
const janusOf = async (slug: string) => {
  const auth = await janusIssuers.forRequest(new Request(url(slug)));
  if (auth === null) throw new Error(`no janus for ${slug}`);
  return auth;
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
  extra: Record<string, string> = {},
): Promise<Answer> {
  const response = await app.request(url(slug), {
    method: "POST",
    headers: {
      ...clientHeaders,
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
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
  requestSignInCode(email: $email) { challenge expiresAt }
}`;
const VERIFY = `mutation ($challenge: String!, $code: String!) {
  verifySignInCode(challenge: $challenge, code: $code) {
    ... on SignedIn { expiresAt user { id email emailVerified } }
  }
}`;
const ME = "{ currentUser { id email emailVerified } }";
const SIGN_OUT = "mutation { signOut }";

// The challenge of a request, and the code mailed to the address (if any).
async function ask(slug: string, email: string) {
  const before = memory.sent.length;
  const answer = await gql(slug, REQUEST, { email });
  await settled();
  const challenge = (
    answer.data?.["requestSignInCode"] as { challenge: string } | undefined
  )?.challenge;
  const mails = memory.sent.slice(before).filter((m) => hasTo(m, email));
  const code = /\b(\d{6})\b/.exec(mails.at(-1)?.text ?? "")?.[1];
  return { answer, challenge: challenge ?? "", code, mails };
}
const hasTo = (mail: (typeof memory.sent)[number], email: string) =>
  JSON.stringify(mail.to).includes(email);

const cookieOf = (answer: Answer) => {
  const header = answer.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return header === undefined ? undefined : (header.split(";")[0] ?? "");
};
const userCount = (partition: string) =>
  oauthDb.collection("partitionedUsers").countDocuments({ partition } as never);

const ADA = "ada@example.test";
let acme = "";
let globex = "";
let closed = "";

beforeAll(async () => {
  await service.create({ slug: "acme", name: "Acme", signUp: true });
  await service.create({ slug: "globex", name: "Globex", signUp: true });
  await service.create({ slug: "vault", name: "Vault" }); // closed by default
  const partition = async (slug: string) =>
    (await tenantResolver.resolveHost(`${slug}.${env.CLAVIX_DOMAIN}`))
      ?.partition ?? "";
  acme = await partition("acme");
  globex = await partition("globex");
  closed = await partition("vault");
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
    "partitionedInvitations",
  ]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

describe("the platform tenant", () => {
  test("clavix is closed: invitation only", async () => {
    const tenant = await tenantResolver.resolveHost(
      `${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`,
    );
    expect(tenant?.signUp).toBe(false);
  });
});

describe("the e-mail code flow", () => {
  test("request, verify, session cookie, currentUser, sign out", async () => {
    const { answer, challenge, code, mails } = await ask("acme", ADA);
    expect(answer.errors).toBeUndefined();
    expect(challenge).toHaveLength(43);
    expect(mails).toHaveLength(1);
    expect(code).toMatch(/^\d{6}$/);
    // The platform sender, the tenant's name; the challenge never travels by e-mail.
    expect(JSON.stringify(mails[0]?.from)).toContain(
      `no-reply@${env.CLAVIX_DOMAIN}`,
    );
    expect(JSON.stringify(mails[0]?.from)).toContain("Acme");
    expect(mails[0]?.text).not.toContain(challenge);
    expect(mails[0]?.html).not.toContain(challenge);

    const verified = await gql("acme", VERIFY, {
      challenge,
      code: code ?? "",
    });
    expect(verified.errors).toBeUndefined();
    const header = verified.cookies.find((c) =>
      c.startsWith(`${SESSION_COOKIE}=`),
    );
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Domain");
    const cookie = cookieOf(verified) ?? "";

    const me = await gql("acme", ME, {}, cookie);
    expect(me.data?.["currentUser"]).toMatchObject({
      email: ADA,
      emailVerified: true,
    });

    const out = await gql("acme", SIGN_OUT, {}, cookie);
    expect(out.data?.["signOut"]).toBe(true);
    const cleared = out.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cleared).toMatch(/Max-Age=0|Expires=/);
    expect(cleared).toContain("Secure");
    expect(cleared).toContain("Path=/");
    expect(
      (await gql("acme", ME, {}, cookie)).data?.["currentUser"],
    ).toBeNull();
  });

  test("a session past its renewal point gets a fresh session cookie", async () => {
    const { challenge, code } = await ask("acme", "renew@example.test");
    const verified = await gql("acme", VERIFY, { challenge, code: code ?? "" });
    const cookie = cookieOf(verified) ?? "";
    expect(cookieOf(await gql("acme", ME, {}, cookie))).toBeUndefined();
    // SESSION.renewAfter is one day: two days on, the session is renewed.
    setSystemTime(new Date(Date.now() + 2 * 24 * 3600 * 1000));
    try {
      const later = await gql("acme", ME, {}, cookie);
      expect(later.data?.["currentUser"]).toMatchObject({
        email: "renew@example.test",
      });
      expect(cookieOf(later)).toBeDefined();
    } finally {
      setSystemTime();
    }
  });

  test("currentUser is null without a session", async () => {
    expect((await gql("acme", ME)).data?.["currentUser"]).toBeNull();
  });

  test("a wrong code is CODE_INVALID, 401, with no attempt count", async () => {
    const { challenge } = await ask("acme", "grace@example.test");
    const wrong = await gql("acme", VERIFY, { challenge, code: "000000" });
    expect(wrong.status).toBe(401);
    expect(wrong.errors?.[0]?.extensions?.["code"]).toBe("CODE_INVALID");
    expect(wrong.errors?.[0]?.extensions).not.toHaveProperty("attemptsLeft");
    expect(wrong.cookies).toEqual([]);
  });

  test("the fifth wrong code spends the challenge, the right one included", async () => {
    const { challenge, code } = await ask("acme", "alan@example.test");
    for (let i = 0; i < 5; i += 1) {
      await gql("acme", VERIFY, { challenge, code: "000001" });
    }
    const late = await gql("acme", VERIFY, { challenge, code: code ?? "" });
    expect(late.errors?.[0]?.extensions?.["code"]).toBe("CODE_INVALID");
    expect(cookieOf(late)).toBeUndefined();
  });

  test("a sixth request for one address in the window is MAIL_THROTTLED, 429", async () => {
    const email = "spam@example.test";
    for (let i = 0; i < 5; i += 1) {
      expect((await gql("acme", REQUEST, { email })).errors).toBeUndefined();
    }
    await settled();
    const sixth = await gql("acme", REQUEST, { email });
    expect(sixth.status).toBe(429);
    expect(sixth.errors?.[0]?.extensions?.["code"]).toBe("MAIL_THROTTLED");
  });

  test("an unknown host is NOT_FOUND", async () => {
    const answer = await gql("nobody", REQUEST, { email: ADA });
    expect(answer.errors?.[0]?.extensions?.["code"]).toBe("NOT_FOUND");
  });
});

describe("tenant isolation", () => {
  test("a code issued on A is refused on B, and still works on A", async () => {
    const { challenge, code } = await ask("acme", "iso@example.test");
    const onB = await gql("globex", VERIFY, { challenge, code: code ?? "" });
    expect(onB.errors?.[0]?.extensions?.["code"]).toBe("CODE_INVALID");
    expect(cookieOf(onB)).toBeUndefined();
    const onA = await gql("acme", VERIFY, { challenge, code: code ?? "" });
    expect(onA.errors).toBeUndefined();
  });

  test("the same e-mail on A and B is two users with separate codes", async () => {
    const a = await ask("acme", "twin@example.test");
    const b = await ask("globex", "twin@example.test");
    expect(a.challenge).not.toBe(b.challenge);
    expect(a.mails).toHaveLength(1);
    expect(b.mails).toHaveLength(1);
    const signedA = await gql("acme", VERIFY, {
      challenge: a.challenge,
      code: a.code ?? "",
    });
    const signedB = await gql("globex", VERIFY, {
      challenge: b.challenge,
      code: b.code ?? "",
    });
    const idOf = (answer: Answer) => {
      const signed = answer.data?.["verifySignInCode"] as
        | { user: { id: string } }
        | undefined;
      if (signed === undefined) throw new Error("not signed in");
      return signed.user.id;
    };
    const idA = idOf(signedA);
    const idB = idOf(signedB);
    expect(idA).not.toBe(idB);
    expect(await (await janusOf("acme")).findUser(idB)).toBeNull();
    expect(await (await janusOf("globex")).findUser(idA)).toBeNull();
  });

  test("the session records the User-Agent as its device label", async () => {
    const agent = "Mozilla/5.0 (X11; Linux) Firefox/130.0";
    const { challenge, code } = await ask("acme", "device@example.test");
    const signed = await gql(
      "acme",
      VERIFY,
      { challenge, code: code ?? "" },
      undefined,
      { "user-agent": agent },
    );
    expect(signed.errors).toBeUndefined();
    const auth = await janusOf("acme");
    const verified = signed.data?.["verifySignInCode"] as {
      user: { id: string };
    };
    const id = verified.user.id;
    expect((await auth.sessions.list({ id })).map((s) => s.device)).toEqual([
      agent,
    ]);
    // No User-Agent: a session with no label.
    const again = await ask("acme", "device@example.test");
    await gql("acme", VERIFY, {
      challenge: again.challenge,
      code: again.code ?? "",
    });
    const labels = (await auth.sessions.list({ id })).map((s) => s.device);
    expect(labels).toHaveLength(2);
    expect(labels).toContain(agent);
  });

  test("a session from A is anonymous on B through GraphQL", async () => {
    const { challenge, code } = await ask("acme", "sess@example.test");
    const cookie =
      cookieOf(await gql("acme", VERIFY, { challenge, code: code ?? "" })) ??
      "";
    expect(
      (await gql("acme", ME, {}, cookie)).data?.["currentUser"],
    ).not.toBeNull();
    expect(
      (await gql("globex", ME, {}, cookie)).data?.["currentUser"],
    ).toBeNull();
  });
});

describe("closed sign-up", () => {
  test("an unknown e-mail gets the same answer as a known one, and nothing is created", async () => {
    // A known user of the closed tenant, made by an invitation.
    const auth = await janusOf("vault");
    const { code: invite } = await auth.invitations.issue({
      scope: "vault",
      email: "member@example.test",
      name: "Member",
      role: "member",
      invitedBy: null,
    });
    const accepted = await auth.invitations.accept({ code: invite });
    expect(accepted.status).toBe("signedIn");
    const before = await userCount(closed);

    const known = await ask("vault", "member@example.test");
    const stranger = await ask("vault", "stranger@example.test");

    expect(stranger.answer.status).toBe(known.answer.status);
    expect(Object.keys(stranger.answer.data ?? {})).toEqual(
      Object.keys(known.answer.data ?? {}),
    );
    expect(stranger.challenge).toHaveLength(known.challenge.length);
    expect(stranger.answer.cookies).toEqual(known.answer.cookies);
    // Only the invited member gets a code; the stranger gets no account.
    expect(known.mails).toHaveLength(1);
    expect(stranger.mails).toHaveLength(0);
    expect(await userCount(closed)).toBe(before);

    // The stranger's wrong code is refused exactly as the member's wrong code.
    const refusedStranger = await gql("vault", VERIFY, {
      challenge: stranger.challenge,
      code: "123456",
    });
    const refusedMember = await gql("vault", VERIFY, {
      challenge: known.challenge,
      code: "000000",
    });
    expect(refusedStranger.status).toBe(refusedMember.status);
    expect(refusedStranger.errors).toEqual(refusedMember.errors);
  });

  test("an invitation lets the user in, then the code flow works", async () => {
    const auth = await janusOf("vault");
    const { code: invite } = await auth.invitations.issue({
      scope: "vault",
      email: "invited@example.test",
      name: "Invited",
      role: "member",
      invitedBy: null,
    });
    const accepted = await auth.invitations.accept({ code: invite });
    if (accepted.status !== "signedIn") throw new Error("not signed in");
    const me = await gql(
      "vault",
      ME,
      {},
      `${SESSION_COOKIE}=${accepted.token}`,
    );
    expect(me.data?.["currentUser"]).toMatchObject({
      email: "invited@example.test",
      emailVerified: true,
    });
    const { challenge, code, mails } = await ask(
      "vault",
      "invited@example.test",
    );
    expect(mails).toHaveLength(1);
    const verified = await gql("vault", VERIFY, {
      challenge,
      code: code ?? "",
    });
    expect(verified.errors).toBeUndefined();
  });

  test("open sign-up creates the account of an unknown e-mail on first sign-in", async () => {
    const before = await userCount(globex);
    const { challenge, code } = await ask("globex", "newcomer@example.test");
    expect(await userCount(globex)).toBe(before + 1);
    const verified = await gql("globex", VERIFY, {
      challenge,
      code: code ?? "",
    });
    expect(verified.errors).toBeUndefined();
    expect(acme).not.toBe(globex);
  });
});

describe("the outbox", () => {
  test("a failed mail is reported by its error name only", async () => {
    const reports: string[] = [];
    afterAnswer(
      async () => {
        throw new TypeError("smtp down for ada@example.test code 123456");
      },
      (message) => reports.push(message),
    );
    await settled();
    expect(reports).toEqual(["auth: sign-in code not sent (TypeError)"]);
  });

  test("the code lifespan janus gets is the 10 minutes the answer states", async () => {
    expect(SIGN_IN_CODE_LIFESPAN).toBe("10m");
    const { answer } = await ask("acme", "clock@example.test");
    const issued = answer.data?.["requestSignInCode"] as
      | { expiresAt: string }
      | undefined;
    if (issued === undefined) throw new Error("no challenge");
    const at = issued.expiresAt;
    const left = new Date(at).getTime() - Date.now();
    expect(left).toBeGreaterThan(9 * 60_000);
    expect(left).toBeLessThanOrEqual(10 * 60_000);
  });
});
