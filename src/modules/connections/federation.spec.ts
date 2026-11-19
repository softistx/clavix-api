import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lookup } from "node:dns/promises";
import { totpCode } from "@softistx/janus/testing";
import {
  createMemorySigningKeys,
  rotateSigningKeys,
  type SigningKeyStore,
} from "@softistx/janus-oauth";
import {
  type Ceremony,
  softwareAuthenticator,
} from "@softistx/janus-passkeys/testing";
import type { MemoryMailer } from "@softistx/mail";
import { createApp } from "@/app";
import { registerClient } from "@/clients/register-client";
import { connectionsService } from "@/config/connections";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver } from "@/config/tenancy";
import { janusIssuers } from "@/config/users";
import { settled } from "@/modules/auth/outbox";
import { SignInPolicyService } from "@/modules/sign-in-methods/service";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { TenantsService } from "@/modules/tenants/tenants.service";
import { ACR, acrOf } from "@/oauth/authentication-level";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import type { AuthFor, ClaimsFor, SigningKeysFor } from "@/oauth/ports";
import { originOf, rpIdOf } from "@/users/rp";
import { SESSION_COOKIE } from "@/users/tenant-janus";
import { createTenantParOff } from "../../../test/tenant-par-off";

// Tenant "fedidp" of this very Clavix is the upstream identity provider of
// tenant "fedacme" (its "Acme SSO"): the whole federated sign-in runs, the
// discovery, the authorization, the code exchange and the ID token's checks.
// The guard's address check resolves the IdP's host: the connections answer a
// public address for the spec's `.test` hosts, with no global DNS mock.
connectionsService.useHostResolver(async (host) =>
  host.endsWith(".clavix.test")
    ? ["93.184.216.34"]
    : (await lookup(host, { all: true })).map((a) => a.address),
);

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const IDP_DOMAIN = "clavix.test";
const IDP_HOST = `fedidp.${IDP_DOMAIN}`;
const IDP_ISSUER = `https://${IDP_HOST}`;
const memory = mailer as MemoryMailer;

const tenants = new TenantsService(mongo.db.tenants, {
  onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
});
const policies = new SignInPolicyService(tenants, {
  seal: () => "",
  open: () => "",
} as never);
const checks: { tenantId: string; ip: string }[] = [];
let throttled = false;
const app = createApp({
  signInThrottle: {
    check: async (key: { tenantId: string; ip: string }) => {
      checks.push(key);
      if (throttled) throw new Error("throttled");
    },
  } as never,
});

// The upstream: its own OAuth issuers over the same database, like oidc.spec.
const idpResolver = (await import("@/tenancy/resolver")).createTenantResolver({
  lookup: (slug: string) => mongo.db.tenants.findFirst({ slug }),
  cache: (await import("@/tenancy/tenant-cache")).noTenantCache,
  config: { scheme: "https", domain: IDP_DOMAIN },
});
const keys = new Map<string, SigningKeyStore>();
const signingKeysFor: SigningKeysFor = (tenantId) => {
  let store = keys.get(tenantId);
  if (store === undefined) {
    store = createMemorySigningKeys();
    keys.set(tenantId, store);
  }
  return store;
};
// Whoever the spec approves as is authenticated; its e-mail is `<id>@acme.test`.
const authFor: AuthFor = () => ({
  authenticate: async () => null,
  findUser: async (id) => ({ id, active: true }),
});
const claimsFor: ClaimsFor = () => async (subject) => ({
  name: `Name of ${subject.id}`,
  email: `${subject.id}@acme.test`,
  email_verified: true,
});
const idp = createClavixOAuthIssuers({
  dpopNonceSecret: "spec-dpop-nonce-secret",
  resolver: idpResolver,
  db: oauthDb,
  signingKeysFor,
  authFor,
  claimsFor,
  resourcesFor: () => ({}),
});
const idpCalls: string[] = [];
const realFetch = globalThis.fetch;

const hostOf = (slug: string) => issuerOf(slug, origin);
const url = (slug: string) => `${hostOf(slug)}/graphql`;
const CALLBACK = `${hostOf("fedacme")}/sign-in/sso/callback`;

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
): Promise<Answer> {
  const response = await app.request(url(slug), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.77",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as Pick<Answer, "data" | "errors">;
  return {
    status: response.status,
    data: body.data ?? null,
    ...(body.errors === undefined ? {} : { errors: body.errors }),
    cookies: response.headers.getSetCookie(),
  };
}
function dataOf<T>(answer: Answer, key: string): T {
  const value = answer.data?.[key];
  if (value === undefined || value === null) {
    throw new Error(`no ${key} in ${JSON.stringify(answer.errors)}`);
  }
  return value as T;
}
const codeOf = (answer: Answer) => answer.errors?.[0]?.extensions?.["code"];
const cookieOf = (answer: Answer) =>
  (answer.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "").split(
    ";",
  )[0] ?? "";

const HOME = `query ($e: String!) { hostedHomeRealm(email: $e) { connectionId name } }`;
const START = `mutation ($p: String!) { socialSignInStart(provider: $p) { url flow } }`;
const COMPLETE = `mutation ($u: String!, $f: String!) {
  socialSignInComplete(callbackUrl: $u, flow: $f) {
    ... on SocialSignedIn { created user { id email emailVerified } }
  }
}`;
const REQUEST = `mutation ($e: EmailAddress!) { requestSignInCode(email: $e) { challenge } }`;
const VERIFY = `mutation ($c: String!, $k: String!) {
  verifySignInCode(challenge: $c, code: $k) { ... on SignedIn { user { id } } }
}`;
const ME = "{ currentUser { email } }";

const homeOf = async (email: string, slug = "fedacme") =>
  (await gql(slug, HOME, { e: email })).data?.["hostedHomeRealm"] ?? null;

/** The visitor's trip to the IdP: authorize, approve as `subject`, and the callback URL it sends back. */
async function throughIdp(authorizeUrl: string, subject: string, acr?: string) {
  const authorize = await idp.handle(new Request(authorizeUrl));
  expect(authorize.status).toBe(302);
  const consent = new URL(
    authorize.headers.get("location") ?? "",
    `${IDP_ISSUER}/`,
  );
  const server = await idp.serverFor(new Request(`${IDP_ISSUER}/`));
  if (server === null) throw new Error("no server for the idp");
  const { redirectTo } = await server.approve(
    { id: subject },
    consent.searchParams.get("request_id") ?? "",
    {
      scopes: ["openid", "email", "profile"],
      authTime: new Date(),
      ...(acr === undefined ? {} : { acr }),
    },
  );
  return redirectTo;
}

/** A whole federated sign-in on `slug` as `<subject>@acme.test`. */
async function federated(
  subject: string,
  slug = "fedacme",
  provider = "acme",
  acr?: string,
) {
  const started = await gql(slug, START, { p: provider });
  if (started.errors !== undefined) return { started } as const;
  const start = started.data?.["socialSignInStart"] as {
    url: string;
    flow: string;
  };
  const callback = await throughIdp(start.url, subject, acr);
  return {
    start,
    callback,
    done: await gql(slug, COMPLETE, { u: callback, f: start.flow }),
  } as const;
}

let acme = "";
let other = "";
let secret = "";
let graceId = "";

async function setSignUp(slug: string, signUp: boolean) {
  await mongo.db.tenants.raw.updateOne(
    { slug },
    { $set: { signUp }, $inc: { version: 1 } },
  );
  await tenantResolver.invalidate([new URL(hostOf(slug)).host]);
}

const activeSessions = async (userId: string) =>
  (
    await (
      await janusIssuers.forRequest(new Request(url("fedacme")))
    )?.sessions.list(userId)
  )?.filter((s) => s.revokedAt === null).length ?? 0;

/** Every session of the user, revoked ones included. */
const sessionsOf = async (userId: string) =>
  (
    await (
      await janusIssuers.forRequest(new Request(url("fedacme")))
    )?.sessions.list(userId)
  )?.length ?? 0;

beforeAll(async () => {
  acme = (await createTenantParOff(tenants, { slug: "fedacme", name: "Acme" }))
    .id;
  other = (
    await createTenantParOff(tenants, { slug: "fedother", name: "Other" })
  ).id;
  await createTenantParOff(tenants, { slug: "fedidp", name: "Idp" });
  const tenant = await idpResolver.resolveHost(IDP_HOST);
  if (tenant === null) throw new Error("the idp tenant is not resolved");
  await rotateSigningKeys(signingKeysFor(tenant.tenantId), {
    now: new Date(),
    lead: "1h",
    retireAfter: "2h",
  });
  const registered = await registerClient(
    { db: oauthDb, findTenant: (slug) => mongo.db.tenants.findFirst({ slug }) },
    {
      tenant: "fedidp",
      name: "Clavix",
      clientId: "clavix",
      redirectUris: [CALLBACK],
      type: "confidential",
    },
  );
  secret = registered.clientSecret ?? "";
  for (const id of [acme, other]) {
    await connectionsService.create(
      id,
      {
        id: "acme",
        name: "Acme SSO",
        issuer: IDP_ISSUER,
        clientId: "clavix",
        clientSecret: secret,
      },
      null,
    );
  }
  // Every call to the IdP goes to its issuers in place of the network.
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = new Request(input as string, init);
    if (new URL(request.url).host !== IDP_HOST) {
      return realFetch(input as string, init);
    }
    idpCalls.push(`${request.method} ${new URL(request.url).pathname}`);
    return idp.handle(request);
  }) as typeof fetch;
}, 30_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await settled();
  await mongo.db.connections.raw.deleteMany({});
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await oauthDb.collection("partitionedUsers").deleteMany({});
  await oauthDb.collection("partitionedSocialLinks").deleteMany({});
}, 30_000);

describe("home-realm discovery", () => {
  test("a domain nobody verified is not discovered", async () => {
    await connectionsService.addDomain(acme, "acme", "acme.test");
    expect(await homeOf("ada@acme.test")).toBeNull();
  });

  test("a verified domain names its connection, whatever the case of the address", async () => {
    await mongo.db.connections.raw.updateMany(
      {},
      { $set: { "domains.$[].verifiedAt": new Date() } },
    );
    expect(await homeOf("ada@acme.test")).toEqual({
      connectionId: "acme",
      name: "Acme SSO",
    });
    expect(await homeOf("Ada@ACME.test")).toEqual({
      connectionId: "acme",
      name: "Acme SSO",
    });
    expect(await homeOf("ada@elsewhere.test")).toBeNull();
  });

  test("it is the tenant's own: another tenant with no verified domain finds nothing", async () => {
    expect(await homeOf("ada@acme.test", "fedother")).toBeNull();
  });

  test("it spends the sign-in limits of the tenant and the client address, and a refusal ends it", async () => {
    checks.length = 0;
    await homeOf("ada@acme.test");
    expect(checks).toEqual([{ tenantId: acme, ip: "198.51.100.77" }]);
    throttled = true;
    const refused = await gql("fedacme", HOME, { e: "ada@acme.test" });
    throttled = false;
    expect(refused.errors).toBeDefined();
    expect(refused.data?.["hostedHomeRealm"] ?? null).toBeNull();
  });

  test("an unknown host is NOT_FOUND", async () => {
    expect(codeOf(await gql("fednobody", HOME, { e: "a@acme.test" }))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("federated sign-in", () => {
  test("a user typing ada@acme.test lands at Acme's IdP and comes back signed in, created by JIT on a tenant whose sign-up is closed", async () => {
    const realm = (await homeOf("ada@acme.test")) as { connectionId: string };
    const started = await federated("ada", "fedacme", realm.connectionId);
    if (!("start" in started) || started.start === undefined)
      throw new Error("the sign-in did not start");
    const target = new URL(started.start.url);
    expect(`${target.origin}${target.pathname}`).toBe(
      `${IDP_ISSUER}/authorize`,
    );
    expect(target.searchParams.get("client_id")).toBe("clavix");
    expect(target.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(started.done.errors).toBeUndefined();
    const done = started.done.data?.["socialSignInComplete"] as {
      created: boolean;
      user: { id: string; email: string; emailVerified: boolean };
    };
    expect(done.created).toBe(true);
    expect(done.user).toMatchObject({
      email: "ada@acme.test",
      emailVerified: true,
    });
    expect((await gql("fedacme", ME, {}, cookieOf(started.done))).data).toEqual(
      { currentUser: { email: "ada@acme.test" } },
    );
    // The session counts as a federated one: `fed`, single-factor (D6).
    const auth = await janusIssuers.forRequest(new Request(url("fedacme")));
    const [session] = (await auth?.sessions.list(done.user.id)) ?? [];
    expect(session?.amr).toEqual(["fed"]);
    // The client secret went to the IdP's token endpoint, and the callback is the tenant's own.
    expect(idpCalls).toContain("POST /token");
  });

  test("a second sign-in of the same address links to the same user", async () => {
    const first = await federated("ada");
    const second = await federated("ada");
    if (!("done" in first) || !("done" in second))
      throw new Error("no sign-in");
    const idOf = (answer: Answer) =>
      dataOf<{
        user: { id: string };
        created: boolean;
      }>(answer, "socialSignInComplete").user.id;
    expect(idOf(second.done)).toBe(idOf(first.done));
    expect(
      dataOf<{ created: boolean }>(second.done, "socialSignInComplete").created,
    ).toBe(false);
  });

  test("an existing user with the verified address is linked, not duplicated", async () => {
    // Made through the e-mail code, while the domain does not yet require single sign-on.
    await connectionsService.update(acme, "acme", { requireSso: false });
    await setSignUp("fedacme", true);
    const before = memory.sent.length;
    const asked = await gql("fedacme", REQUEST, { e: "grace@acme.test" });
    await settled();
    const code = /\b(\d{6})\b/.exec(
      memory.sent.slice(before).at(-1)?.text ?? "",
    )?.[1];
    const challenge = dataOf<{ challenge: string }>(
      asked,
      "requestSignInCode",
    ).challenge;
    const verified = await gql("fedacme", VERIFY, { c: challenge, k: code });
    const known = dataOf<{ user: { id: string } }>(verified, "verifySignInCode")
      .user.id;
    graceId = known;
    await setSignUp("fedacme", false);
    await connectionsService.update(acme, "acme", { requireSso: true });

    const linked = await federated("grace");
    if (!("done" in linked)) throw new Error("no sign-in");
    const done = linked.done.data?.["socialSignInComplete"] as {
      created: boolean;
      user: { id: string };
    };
    expect(done.created).toBe(false);
    expect(done.user.id).toBe(known);
  });

  test("a connection with linked accounts is not deleted, counted by the tenant's own store", async () => {
    await expect(connectionsService.delete(acme, "acme")).rejects.toMatchObject(
      { code: "CONNECTION_IN_USE" },
    );
  });

  test("jit off: a new user is not created, even from the company's own IdP", async () => {
    await connectionsService.update(acme, "acme", { jit: false });
    const refused = await federated("newcomer");
    if (!("done" in refused)) throw new Error("no sign-in");
    expect(codeOf(refused.done)).toBe("SIGN_UP_DISABLED");
    expect(refused.done.cookies).toEqual([]);
    // A user that exists still signs in.
    const known = await federated("ada");
    if (!("done" in known)) throw new Error("no sign-in");
    expect(known.done.errors).toBeUndefined();
    await connectionsService.update(acme, "acme", { jit: true });
  });

  test("a connection that asks for the IdP's MFA refuses an ID token without the acr (D6)", async () => {
    await connectionsService.update(acme, "acme", {
      upstreamMfa: { acr: "urn:acme:mfa" },
    });
    const refused = await federated("ada");
    if (!("done" in refused)) throw new Error("no sign-in");
    expect(codeOf(refused.done)).toBe("SOCIAL_STEP_UP_UNMET");
    expect(refused.done.cookies).toEqual([]);
    await connectionsService.update(acme, "acme", { upstreamMfa: null });
  });

  test("a connection that trusts the IdP's MFA gives the session mfa, so acr mfa is reached (D6)", async () => {
    await connectionsService.update(acme, "acme", {
      upstreamMfa: { acr: "urn:acme:mfa" },
    });
    try {
      const done = await federated("mia", "fedacme", "acme", "urn:acme:mfa");
      if (!("done" in done)) throw new Error("no sign-in");
      expect(done.done.errors).toBeUndefined();
      const user = dataOf<{ user: { id: string } }>(
        done.done,
        "socialSignInComplete",
      ).user;
      const auth = await janusIssuers.forRequest(new Request(url("fedacme")));
      const [session] = (await auth?.sessions.list(user.id)) ?? [];
      expect(session?.amr).toEqual(["fed", "mfa"]);
      expect(acrOf(session?.amr ?? [])).toBe(ACR.mfa);
    } finally {
      await connectionsService.update(acme, "acme", { upstreamMfa: null });
    }
  });

  test("the callback of another tenant with this tenant's flow is refused (mix-up)", async () => {
    const started = await gql("fedacme", START, { p: "acme" });
    const start = started.data?.["socialSignInStart"] as {
      url: string;
      flow: string;
    };
    const callback = await throughIdp(start.url, "ada");
    const calls = idpCalls.length;
    const mixed = await gql("fedother", COMPLETE, {
      u: callback,
      f: start.flow,
    });
    expect(mixed.errors).toBeDefined();
    expect(mixed.cookies).toEqual([]);
    expect(idpCalls.length).toBe(calls);
    // The right tenant still completes it.
    const real = await gql("fedacme", COMPLETE, { u: callback, f: start.flow });
    expect(real.errors).toBeUndefined();
  });

  test("a connection that is not the tenant's, or unknown, does not start", async () => {
    for (const provider of ["nope", "google", "Acme"]) {
      const refused = await gql("fedacme", START, { p: provider });
      expect(codeOf(refused)).toBe("SIGN_IN_METHOD_DISABLED");
    }
    await connectionsService.delete(other, "acme");
    expect(codeOf(await gql("fedother", START, { p: "acme" }))).toBe(
      "SIGN_IN_METHOD_DISABLED",
    );
  });
});

describe("single sign-on required (D3)", () => {
  test("the e-mail code is refused for an address of the domain, before any mail", async () => {
    const before = memory.sent.length;
    for (const email of ["grace@acme.test", "stranger@acme.test"]) {
      const refused = await gql("fedacme", REQUEST, { e: email });
      expect(codeOf(refused)).toBe("SSO_REQUIRED");
      expect(refused.status).toBe(403);
    }
    await settled();
    expect(memory.sent.length).toBe(before);
    // Another domain is untouched: the usual uniform answer.
    expect(
      (await gql("fedacme", REQUEST, { e: "bob@other.test" })).errors,
    ).toBe(undefined);
  });

  test("a code asked for before the rule is refused at the verification, and no session is left", async () => {
    await connectionsService.update(acme, "acme", { requireSso: false });
    const before = memory.sent.length;
    const asked = await gql("fedacme", REQUEST, { e: "grace@acme.test" });
    await settled();
    const code = /\b(\d{6})\b/.exec(
      memory.sent.slice(before).at(-1)?.text ?? "",
    )?.[1];
    const challenge = dataOf<{ challenge: string }>(
      asked,
      "requestSignInCode",
    ).challenge;
    await connectionsService.update(acme, "acme", { requireSso: true });
    const sessions = await activeSessions(graceId);
    const refused = await gql("fedacme", VERIFY, { c: challenge, k: code });
    expect(codeOf(refused)).toBe("SSO_REQUIRED");
    expect(cookieOf(refused)).toBe("");
    expect(await activeSessions(graceId)).toBe(sessions);
  });

  test("a connection that turned the rule off lets the code through", async () => {
    await connectionsService.update(acme, "acme", { requireSso: false });
    const refused = await gql("fedacme", REQUEST, { e: "grace@acme.test" });
    expect(refused.errors).toBeUndefined();
    await connectionsService.update(acme, "acme", { requireSso: true });
  });
});

describe("a connection turned off", () => {
  test("it is not discovered, does not start, and a flow begun before cannot complete", async () => {
    const started = await gql("fedacme", START, { p: "acme" });
    const start = started.data?.["socialSignInStart"] as {
      url: string;
      flow: string;
    };
    const callback = await throughIdp(start.url, "ada");
    await connectionsService.update(acme, "acme", { enabled: false });
    expect(await homeOf("ada@acme.test")).toBeNull();
    expect(codeOf(await gql("fedacme", START, { p: "acme" }))).toBe(
      "SIGN_IN_METHOD_DISABLED",
    );
    const late = await gql("fedacme", COMPLETE, { u: callback, f: start.flow });
    expect(late.errors).toBeDefined();
    expect(late.cookies).toEqual([]);
    // Turned off, its domain no longer requires single sign-on: the code is offered again.
    expect((await gql("fedacme", REQUEST, { e: "ada@acme.test" })).errors).toBe(
      undefined,
    );
  });
});

const SIGN_IN_OPTIONS = `mutation { passkeySignInOptions { options challenge } }`;
const PASSKEY = `mutation ($c: String!, $r: String!) {
  signInWithPasskey(challenge: $c, response: $r) { user { id } }
}`;
const REG_OPTIONS = `mutation { passkeyRegistrationOptions { options challenge } }`;
const REGISTER = `mutation ($c: String!, $r: String!) {
  registerPasskey(challenge: $c, response: $r, name: "Laptop") { id }
}`;
const LINK = `mutation ($t: String!) {
  confirmMagicLink(token: $t) { ... on SignedIn { user { id } } }
}`;
const LINK_REQUEST = `mutation ($e: EmailAddress!) { requestMagicLink(email: $e) { expiresAt } }`;
const CHALLENGE_VERIFY = `mutation ($c: String!, $k: String!) {
  verifySignInCode(challenge: $c, code: $k) { __typename }
}`;
const CHALLENGE_OF = `mutation ($c: String!, $k: String!) {
  verifySignInCode(challenge: $c, code: $k) {
    ... on SecondFactorChallenge { challenge }
  }
}`;
const CONFIRM_TOTP = `mutation ($c: String!, $k: String!) {
  confirmSecondFactor(challenge: $c, code: $k) { user { id } }
}`;
const ENROLL = "mutation { enrollSecondFactor { secret } }";
const ACTIVATE =
  "mutation ($k: String!) { activateSecondFactor(code: $k) { recoveryCodes } }";

/** A signed-in cookie for `email`, opened through janus directly (verified address). */
async function userWithSession(email: string) {
  const auth = await janusIssuers.forRequest(new Request(url("fedacme")));
  if (auth === null) throw new Error("no janus for fedacme");
  const user = await auth.create({ email });
  await auth.verifyEmail.confirm((await auth.verifyEmail.send(user)).token);
  const result = await auth.signInProven(
    (await auth.findUser(user.id)) ?? user,
  );
  if (result.status !== "signedIn") throw new Error("no session");
  return { id: user.id, cookie: `${SESSION_COOKIE}=${result.token}` };
}

/** The e-mailed six-digit code of the last mail to `email`, after `before` mails. */
const codeFrom = (before: number, email: string) =>
  /\b(\d{6})\b/.exec(
    memory.sent
      .slice(before)
      .filter((m) => JSON.stringify(m.to).includes(email))
      .at(-1)?.text ?? "",
  )?.[1] ?? "";

describe("single sign-on required: the other doors (D3)", () => {
  test("a magic link is refused at the request, before any mail, and at the confirmation of one asked before the rule", async () => {
    // The previous describe turned the connection off.
    await connectionsService.update(acme, "acme", {
      enabled: true,
      requireSso: true,
    });
    await policies.updateMethods(acme, [{ type: "magicLink", enabled: true }]);
    const before = memory.sent.length;
    const refused = await gql("fedacme", LINK_REQUEST, { e: "mia@acme.test" });
    expect(codeOf(refused)).toBe("SSO_REQUIRED");
    expect(refused.status).toBe(403);
    await settled();
    expect(memory.sent.length).toBe(before);

    // A link asked while the rule was off is refused when it is used.
    await connectionsService.update(acme, "acme", { requireSso: false });
    const max = await userWithSession("max@acme.test");
    const live = await activeSessions(max.id);
    const asked = await gql("fedacme", LINK_REQUEST, { e: "max@acme.test" });
    expect(asked.errors).toBeUndefined();
    await settled();
    const token = new URL(
      /https?:\/\/[^\s"'<>]+\/sign-in\/link\?token=[\w-]+/.exec(
        memory.sent
          .slice(before)
          .filter((m) => JSON.stringify(m.to).includes("max@acme.test"))
          .at(-1)?.text ?? "",
      )?.[0] ?? "",
    ).searchParams.get("token");
    await connectionsService.update(acme, "acme", { requireSso: true });
    const done = await gql("fedacme", LINK, { t: token ?? "" });
    expect(codeOf(done)).toBe("SSO_REQUIRED");
    expect(cookieOf(done)).toBe("");
    expect(await activeSessions(max.id)).toBe(live);
  });

  test("a user holding TOTP gets SSO_REQUIRED, not a second-factor challenge, and no session", async () => {
    await connectionsService.update(acme, "acme", { requireSso: false });
    await policies.updateMfa(acme, { totp: true });
    const email = "tess@acme.test";
    const { id: tessId, cookie } = await userWithSession(email);
    const enrolled = await gql("fedacme", ENROLL, {}, cookie);
    const totp = dataOf<{ secret: string }>(enrolled, "enrollSecondFactor");
    expect(
      (await gql("fedacme", ACTIVATE, { k: totpCode(totp.secret) }, cookie))
        .errors,
    ).toBeUndefined();

    // Asked while the rule is off: it would end at a challenge.
    const again = memory.sent.length;
    const second = await gql("fedacme", REQUEST, { e: email });
    await settled();
    const challenge = dataOf<{ challenge: string }>(
      second,
      "requestSignInCode",
    ).challenge;
    const code = codeFrom(again, email);
    await connectionsService.update(acme, "acme", { requireSso: true });
    const refused = await gql("fedacme", CHALLENGE_VERIFY, {
      c: challenge,
      k: code,
    });
    expect(codeOf(refused)).toBe("SSO_REQUIRED");
    expect(refused.data?.["verifySignInCode"] ?? null).toBeNull();
    expect(cookieOf(refused)).toBe("");

    // A challenge issued while the rule was off opens no session once it is on.
    await connectionsService.update(acme, "acme", { requireSso: false });
    const third = memory.sent.length;
    const asked3 = await gql("fedacme", REQUEST, { e: email });
    await settled();
    const issued = await gql("fedacme", CHALLENGE_OF, {
      c: dataOf<{ challenge: string }>(asked3, "requestSignInCode").challenge,
      k: codeFrom(third, email),
    });
    const pending = dataOf<{ challenge: string }>(issued, "verifySignInCode");
    await connectionsService.update(acme, "acme", { requireSso: true });
    const live = await activeSessions(tessId);
    const blocked = await gql("fedacme", CONFIRM_TOTP, {
      c: pending.challenge,
      k: totpCode(totp.secret, new Date(Date.now() + 30_000)),
    });
    expect(codeOf(blocked)).toBe("SSO_REQUIRED");
    expect(await activeSessions(tessId)).toBe(live);
    // janus-graphql queued its cookie: it names a revoked session.
    expect(cookieOf(blocked)).not.toBe("");
    const stale = await gql("fedacme", ME, {}, cookieOf(blocked));
    expect(stale.data?.["currentUser"] ?? null).toBeNull();
    await policies.updateMfa(acme, { totp: false });
  });

  test("a passkey sign-in is refused by the sign-in guard: no cookie and no session", async () => {
    await connectionsService.update(acme, "acme", { requireSso: false });
    const { id, cookie } = await userWithSession("pam@acme.test");
    const tenant = await tenantResolver.resolveHost(
      `fedacme.${env.CLAVIX_DOMAIN}`,
    );
    if (tenant === null) throw new Error("no tenant");
    const authenticator = await softwareAuthenticator();
    const challengeOf = (options: string) =>
      String((JSON.parse(options) as { challenge: unknown }).challenge);
    const reg = dataOf<{ options: string; challenge: string }>(
      await gql("fedacme", REG_OPTIONS, {}, cookie),
      "passkeyRegistrationOptions",
    );
    const registration = await authenticator.register({
      challenge: challengeOf(reg.options),
      origin: originOf(tenant),
      rpId: rpIdOf(tenant),
    });
    const registered = await gql(
      "fedacme",
      REGISTER,
      { c: reg.challenge, r: JSON.stringify(registration) },
      cookie,
    );
    expect(registered.errors).toBeUndefined();
    await connectionsService.update(acme, "acme", { requireSso: true });

    const issued = dataOf<{ options: string; challenge: string }>(
      await gql("fedacme", SIGN_IN_OPTIONS),
      "passkeySignInOptions",
    );
    const ceremony: Partial<Ceremony> = {
      challenge: challengeOf(issued.options),
      origin: originOf(tenant),
      rpId: rpIdOf(tenant),
      userHandle: Buffer.from(id).toString("base64url"),
      counter: 1,
    };
    const response = await authenticator.assert(ceremony as Ceremony);
    const live = await activeSessions(id);
    const total = await sessionsOf(id);
    const refused = await gql("fedacme", PASSKEY, {
      c: issued.challenge,
      r: JSON.stringify(response),
    });
    expect(codeOf(refused)).toBe("SSO_REQUIRED");
    // janus-graphql's `signInGuard` throws before any session, token or
    // cookie exists: nothing was opened, so nothing was revoked.
    expect(refused.data?.["signInWithPasskey"] ?? null).toBeNull();
    expect(cookieOf(refused)).toBe("");
    expect(await activeSessions(id)).toBe(live);
    expect(await sessionsOf(id)).toBe(total);
  });
});
