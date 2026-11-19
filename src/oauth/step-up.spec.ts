import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  DEVICE_GRANT,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { softwareAuthenticator } from "@softistx/janus-passkeys/testing";
import { decodeJwt } from "jose";
import { createApp } from "@/app";
import { registerClient } from "@/clients/register-client";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { authFor, claimsFor, janusIssuers } from "@/config/users";
import { SignInPolicyService } from "@/modules/sign-in-methods/service";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { originOf, rpIdOf } from "@/users/rp";
import { SESSION_COOKIE } from "@/users/tenant-janus";
import { createTenantParOff } from "../../test/tenant-par-off";
import { ACR } from "./authentication-level";
import { createClavixOAuthIssuers } from "./issuers";

// The step-up end to end (M2): what a request asks (`acr_values`, `max_age`,
// `prompt=login`) and what the tenant's policy asks (`required`) against what
// the session proved, then a passkey step-up that meets it, and the `acr` and
// `amr` the tokens carry.
const RESOURCE = "https://api.clavix.test/mcp";
const REDIRECT = "https://app.example/callback";
const VERIFIER = "v".repeat(64);
const UNMET = "UNMET_AUTHENTICATION_REQUIREMENTS";
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const keys = new Map<string, SigningKeyStore>();
const signingKeysFor = (tenantId: string) => {
  let store = keys.get(tenantId);
  if (store === undefined) {
    store = createMemorySigningKeys();
    keys.set(tenantId, store);
  }
  return store;
};
const issuers = createClavixOAuthIssuers({
  dpopNonceSecret: "spec-dpop-nonce-secret",
  resolver: tenantResolver,
  db: oauthDb,
  signingKeysFor,
  authFor,
  claimsFor,
  resourcesFor: () => ({ [RESOURCE]: { scopes: ["read"] } }),
});
const app = createApp({ oauth: issuers });
const policies = new SignInPolicyService(tenantsService, {
  seal: () => "",
  open: () => "",
} as never);
const url = (slug: string, path = "/") => `${issuerOf(slug, origin)}${path}`;

interface GqlResult {
  data?: Record<string, unknown> | null;
  errors?: {
    message: string;
    extensions?: { code?: string; missing?: string[] };
  }[];
}
const gql = async (
  slug: string,
  query: string,
  variables: Record<string, unknown>,
  cookie: string,
): Promise<GqlResult> => {
  const response = await app.request(url(slug, "/graphql"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as GqlResult;
};
const fieldOf = <T>(result: GqlResult, key: string): T => {
  const value = result.data?.[key];
  if (value === undefined || value === null) {
    throw new Error(`no ${key}: ${JSON.stringify(result.errors)}`);
  }
  return value as T;
};
const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions?.code;

const AUTH = `query($id: ID!) { oauthRequest(id: $id) { authentication { acr current maxAge met missing } } }`;
const DEVICE_AUTH = `query($code: String!) { oauthDeviceRequest(userCode: $code) { authentication { acr current met missing } } }`;
const APPROVE = `mutation($id: ID!) { approveOAuthRequest(id: $id) { redirectTo } }`;
const DEVICE_APPROVE = `mutation($code: String!) { approveOAuthDeviceRequest(userCode: $code) }`;
const STEP_UP_OPTIONS = `mutation { requestPasskeyStepUp { options challenge } }`;
const STEP_UP_CONFIRM = `mutation($c: String!, $r: String!) { confirmPasskeyStepUp(challenge: $c, response: $r) { confirmedAt } }`;

interface Authentication {
  acr: string | null;
  current: string;
  maxAge?: number | null;
  met: boolean;
  missing: string[];
}
const authenticationOf = async (
  slug: string,
  id: string,
  cookie: string,
): Promise<Authentication> => {
  const result = await gql(slug, AUTH, { id }, cookie);
  expect(result.errors).toBeUndefined();
  return fieldOf<{ authentication: Authentication }>(result, "oauthRequest")
    .authentication;
};

interface Person {
  cookie: string;
  userId: string;
  ceremony: (challenge: string) => Promise<unknown>;
}
const clients: Record<string, string> = {};

/** A user signed in by an e-mailed code alone (one factor: `otp`), with or without a passkey. */
async function signedIn(
  slug: string,
  email: string,
  passkey: boolean,
): Promise<Person> {
  const tenant = await tenantResolver.resolveHost(new URL(url(slug)).host);
  const auth = await janusIssuers.forRequest(new Request(url(slug)));
  if (tenant === null || auth === null) throw new Error("no tenant");
  const created = await auth.create({ email });
  await auth.verifyEmail.confirm((await auth.verifyEmail.send(created)).token);
  const user = (await auth.findUser(created.id)) ?? created;
  const opened = await auth.signInProven(user);
  if (opened.status !== "signedIn") throw new Error("no session");
  const cookie = `${SESSION_COOKIE}=${opened.token}`;
  const authenticator = await softwareAuthenticator();
  const handle = Buffer.from(user.id).toString("base64url");
  const person: Person = {
    cookie,
    userId: user.id,
    ceremony: (challenge) =>
      authenticator.assert({
        challenge,
        origin: originOf(tenant),
        rpId: rpIdOf(tenant),
        userHandle: handle,
      }),
  };
  if (passkey) {
    // A passkey-only user: no authenticator app (nxgt-janus#951).
    const asked = await auth.passkeys.registrationOptions(user);
    const current = await auth.authenticate(
      new Request(url(slug), { headers: { cookie } }),
    );
    if (current === null) throw new Error("no session");
    await auth.passkeys.register(current, {
      challenge: asked.challenge,
      response: await authenticator.register({
        challenge: String(asked.options["challenge"]),
        origin: originOf(tenant),
        rpId: rpIdOf(tenant),
      }),
      name: "Laptop",
    });
  }
  return person;
}

/** The passkey step-up of the session, as the page would run it. */
async function stepUp(slug: string, person: Person) {
  const issued = await gql(slug, STEP_UP_OPTIONS, {}, person.cookie);
  expect(issued.errors).toBeUndefined();
  const { options, challenge } = fieldOf<{
    options: string;
    challenge: string;
  }>(issued, "requestPasskeyStepUp");
  const response = await person.ceremony(
    String((JSON.parse(options) as { challenge: string }).challenge),
  );
  const confirmed = await gql(
    slug,
    STEP_UP_CONFIRM,
    { c: challenge, r: JSON.stringify(response) },
    person.cookie,
  );
  expect(confirmed.errors).toBeUndefined();
}

const agedBy = (userId: string, seconds: number) =>
  oauthDb
    .collection("partitionedSessions")
    .updateMany(
      { userId },
      { $set: { authenticatedAt: new Date(Date.now() - seconds * 1000) } },
    );

async function authorize(slug: string, extra: Record<string, string> = {}) {
  const response = await issuers.handle(
    new Request(
      url(
        slug,
        `/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: "backend",
          redirect_uri: REDIRECT,
          code_challenge: await s256Challenge(VERIFIER),
          code_challenge_method: "S256",
          scope: "openid email",
          nonce: "n-0S6_WzA2Mj",
          state: "xyz",
          ...extra,
        })}`,
      ),
    ),
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "", url(slug));
  expect(location.href).toContain("/consent");
  return location.searchParams.get("request_id") ?? "";
}

const token = (slug: string, body: Record<string, string>) =>
  issuers.handle(
    new Request(url(slug, "/token"), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`backend:${clients[slug]}`)}`,
      },
      body: new URLSearchParams(body),
    }),
  );

async function approved(slug: string, id: string, cookie: string) {
  const result = await gql(slug, APPROVE, { id }, cookie);
  expect(result.errors).toBeUndefined();
  const { redirectTo } = fieldOf<{
    redirectTo: string;
  }>(result, "approveOAuthRequest");
  const response = await token(slug, {
    grant_type: "authorization_code",
    code: new URL(redirectTo).searchParams.get("code") ?? "",
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
  };
}

const tenantIds: Record<string, string> = {};

async function setMode(slug: string, mode: "required") {
  await policies.updateMfa(tenantIds[slug] ?? "", { mode });
  await tenantResolver.invalidate([new URL(url(slug)).host]);
}

beforeAll(async () => {
  for (const slug of ["stup", "stupreq", "stupdev"]) {
    tenantIds[slug] = (
      await createTenantParOff(tenantsService, { slug, name: slug })
    ).id;
    const tenant = await tenantResolver.resolveHost(new URL(url(slug)).host);
    if (tenant === null) throw new Error("tenant not resolved");
    await policies.updateMfa(tenant.tenantId, { totp: true });
    await rotateSigningKeys(signingKeysFor(tenant.tenantId), {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
    const registered = await registerClient(
      {
        db: oauthDb,
        findTenant: (s) => mongo.db.tenants.findFirst({ slug: s }),
      },
      {
        tenant: slug,
        name: "Back end",
        clientId: "backend",
        redirectUris: [REDIRECT],
        type: "confidential",
        grants: ["authorization_code", "refresh_token"],
      },
    );
    clients[slug] = registered.clientSecret ?? "";
  }
  await setMode("stupreq", "required");
  await setMode("stupdev", "required");
}, 30_000);

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  for (const name of [
    "partitionedUsers",
    "partitionedSessions",
    "partitionedPasskeys",
  ]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

describe("acr_values", () => {
  test("acr mfa is refused for a code-only session, then a passkey step-up is approved with acr and amr", async () => {
    const ada = await signedIn("stup", "ada@example.test", true);
    const id = await authorize("stup", { acr_values: ACR.mfa });
    expect(await authenticationOf("stup", id, ada.cookie)).toMatchObject({
      acr: ACR.mfa,
      current: ACR.first,
      met: false,
      missing: ["SECOND_FACTOR"],
    });
    const refused = await gql("stup", APPROVE, { id }, ada.cookie);
    expect(codeOf(refused)).toBe(UNMET);
    expect(refused.errors?.[0]?.extensions?.missing).toEqual(["SECOND_FACTOR"]);

    await stepUp("stup", ada);
    expect(await authenticationOf("stup", id, ada.cookie)).toMatchObject({
      met: true,
      missing: [],
    });
    const tokens = await approved("stup", id, ada.cookie);
    const claims = decodeJwt(tokens.id_token);
    expect(claims["acr"]).toBe(ACR.mfa);
    expect(claims["amr"]).toEqual(
      expect.arrayContaining(["hwk", "user", "mfa"]),
    );
    // The access token states the same (RFC 9068, nxgt-janus#952).
    const access = decodeJwt(tokens.access_token);
    expect(access["acr"]).toBe(claims["acr"]);
    expect(access["amr"]).toEqual(claims["amr"]);
    expect(access["auth_time"]).toBe(claims["auth_time"]);
  });

  test("a passkey-only user steps up to acr phr, with no authenticator app", async () => {
    const pat = await signedIn("stup", "pat@example.test", true);
    const id = await authorize("stup", { acr_values: ACR.phishingResistant });
    await stepUp("stup", pat);
    const tokens = await approved("stup", id, pat.cookie);
    expect(decodeJwt(tokens.id_token)["acr"]).toBe(ACR.phishingResistant);
    expect(decodeJwt(tokens.access_token)["acr"]).toBe(ACR.phishingResistant);
  });

  test("a code-only session meets acr 1fa and the ID token says so", async () => {
    const bob = await signedIn("stup", "bob@example.test", false);
    const id = await authorize("stup", { acr_values: ACR.first });
    const tokens = await approved("stup", id, bob.cookie);
    const claims = decodeJwt(tokens.id_token);
    expect(claims["acr"]).toBe(ACR.first);
    // `signInProven` records no method; the `email` naming is unit-tested.
    expect(claims["amr"]).toEqual([]);
  });

  test("a user with no second factor to prove is told to enrol", async () => {
    const cy = await signedIn("stup", "cy@example.test", false);
    const id = await authorize("stup", { acr_values: ACR.mfa });
    expect(await authenticationOf("stup", id, cy.cookie)).toMatchObject({
      met: false,
      missing: ["ENROLMENT"],
    });
    expect(codeOf(await gql("stup", APPROVE, { id }, cy.cookie))).toBe(UNMET);
  });

  test("a value Clavix does not issue cannot be met, and nothing is missing", async () => {
    const dee = await signedIn("stup", "dee@example.test", true);
    const id = await authorize("stup", { acr_values: "urn:other:acr" });
    expect(await authenticationOf("stup", id, dee.cookie)).toMatchObject({
      met: false,
      missing: [],
    });
    // Nothing the user can do: the client is told, not left waiting
    // (nxgt-janus#949, RFC 9470), and the request is spent.
    const refused = await gql("stup", APPROVE, { id }, dee.cookie);
    expect(refused.errors).toBeUndefined();
    const { redirectTo } = fieldOf<{ redirectTo: string }>(
      refused,
      "approveOAuthRequest",
    );
    const back = new URL(redirectTo);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("error")).toBe(
      "unmet_authentication_requirements",
    );
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("code")).toBeNull();
    expect(
      (await gql("stup", APPROVE, { id }, dee.cookie)).errors,
    ).toBeDefined();
  });

  test("refresh keeps the acr of the approval", async () => {
    const eve = await signedIn("stup", "eve@example.test", true);
    await stepUp("stup", eve);
    const id = await authorize("stup", { acr_values: ACR.mfa });
    const tokens = await approved("stup", id, eve.cookie);
    expect(tokens.refresh_token).toBeDefined();
    const refreshed = await token("stup", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
    });
    expect(refreshed.status).toBe(200);
    const { id_token } = (await refreshed.json()) as { id_token?: string };
    if (id_token !== undefined) {
      expect(decodeJwt(id_token)["acr"]).toBe(ACR.mfa);
    }
  });
});

describe("max_age and prompt=login", () => {
  test("max_age=0 asks a fresh proof of a session older than a minute, and the step-up gives it", async () => {
    const fay = await signedIn("stup", "fay@example.test", true);
    await agedBy(fay.userId, 120);
    const id = await authorize("stup", { max_age: "0" });
    expect(await authenticationOf("stup", id, fay.cookie)).toMatchObject({
      maxAge: 0,
      met: false,
      missing: ["FRESH_PROOF"],
    });
    expect(codeOf(await gql("stup", APPROVE, { id }, fay.cookie))).toBe(UNMET);
    await stepUp("stup", fay);
    expect((await authenticationOf("stup", id, fay.cookie)).met).toBe(true);
    const claims = decodeJwt((await approved("stup", id, fay.cookie)).id_token);
    expect(claims["auth_time"]).toBeGreaterThan(Date.now() / 1000 - 30);
  });

  test("prompt=login counts as max_age=0, and a larger max_age allows the old proof", async () => {
    const gus = await signedIn("stup", "gus@example.test", true);
    await agedBy(gus.userId, 120);
    const login = await authorize("stup", { prompt: "login" });
    expect(await authenticationOf("stup", login, gus.cookie)).toMatchObject({
      maxAge: 0,
      met: false,
      missing: ["FRESH_PROOF"],
    });
    const lenient = await authorize("stup", { max_age: "600" });
    expect(await authenticationOf("stup", lenient, gus.cookie)).toMatchObject({
      maxAge: 600,
      met: true,
    });
  });
});

describe("the tenant requires a second factor", () => {
  test("with no factor the gap is the enrolment, whatever the request says", async () => {
    const hal = await signedIn("stupreq", "hal@example.test", false);
    const id = await authorize("stupreq");
    expect(await authenticationOf("stupreq", id, hal.cookie)).toMatchObject({
      acr: ACR.mfa,
      met: false,
      missing: ["ENROLMENT"],
    });
    expect(codeOf(await gql("stupreq", APPROVE, { id }, hal.cookie))).toBe(
      UNMET,
    );
  });

  test("a passkey step-up meets it and the approval is phishing resistant", async () => {
    const ivy = await signedIn("stupreq", "ivy@example.test", true);
    const id = await authorize("stupreq");
    expect((await authenticationOf("stupreq", id, ivy.cookie)).missing).toEqual(
      ["SECOND_FACTOR"],
    );
    await stepUp("stupreq", ivy);
    const claims = decodeJwt(
      (await approved("stupreq", id, ivy.cookie)).id_token,
    );
    expect(claims["acr"]).toBe(ACR.phishingResistant);
  });
});

describe("the device flow", () => {
  const device = async (slug: string) => {
    await registerClient(
      {
        db: oauthDb,
        findTenant: (s) => mongo.db.tenants.findFirst({ slug: s }),
      },
      {
        tenant: slug,
        name: "Living room TV",
        clientId: "tv",
        redirectUris: [],
        grants: [DEVICE_GRANT],
      },
    );
    const response = await issuers.handle(
      new Request(url(slug, "/device_authorization"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "tv", scope: "openid email" }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      device_code: string;
      user_code: string;
    };
  };

  test("behaves like the code flow: refused with the gap, approved after a passkey step-up", async () => {
    const jo = await signedIn("stupdev", "jo@example.test", true);
    const { device_code, user_code } = await device("stupdev");
    const read = await gql(
      "stupdev",
      DEVICE_AUTH,
      { code: user_code },
      jo.cookie,
    );
    expect(read.errors).toBeUndefined();
    expect(
      fieldOf<{
        authentication: Authentication;
      }>(read, "oauthDeviceRequest").authentication,
    ).toMatchObject({ met: false, missing: ["SECOND_FACTOR"] });
    expect(
      codeOf(
        await gql("stupdev", DEVICE_APPROVE, { code: user_code }, jo.cookie),
      ),
    ).toBe(UNMET);

    await stepUp("stupdev", jo);
    const done = await gql(
      "stupdev",
      DEVICE_APPROVE,
      { code: user_code },
      jo.cookie,
    );
    expect(done.errors).toBeUndefined();
    const polled = await issuers.handle(
      new Request(url("stupdev", "/token"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          device_code,
          client_id: "tv",
        }),
      }),
    );
    expect(polled.status).toBe(200);
    const { id_token } = (await polled.json()) as { id_token: string };
    expect(decodeJwt(id_token)["acr"]).toBe(ACR.phishingResistant);
  });
});
