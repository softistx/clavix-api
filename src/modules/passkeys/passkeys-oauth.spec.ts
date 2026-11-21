import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  rotateSigningKeys,
  s256Challenge,
} from "@softistx/janus-oauth";
import { softwareAuthenticator } from "@softistx/janus-passkeys/testing";
import { decodeJwt } from "jose";
import { createApp } from "@/app";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver } from "@/config/tenancy";
import { authFor, claimsFor, janusIssuers } from "@/config/users";
import { registerClient } from "@/modules/clients/register-client";
import {
  issuerOf,
  PLATFORM_TENANT_SLUG,
  TenantsService,
} from "@/modules/tenants";
import { originOf, rpIdOf } from "@/modules/users/rp";
import { SESSION_COOKIE } from "@/modules/users/tenant-janus";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { createTenantParOff } from "../../../test/tenant-par-off";

// A passkey sign-in, then the OAuth flow of the same tenant: the id_token's
// auth_time is the passkey session's sign-in time.
const RESOURCE = "https://api.clavix.test/mcp";
const REDIRECT = "https://app.example/callback";
const VERIFIER = "v".repeat(64);
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const keys = createMemorySigningKeys();
const issuers = createClavixOAuthIssuers({
  dpopNonceSecret: "spec-dpop-nonce-secret",
  resolver: tenantResolver,
  db: oauthDb,
  signingKeysFor: () => keys,
  authFor,
  claimsFor,
  resourcesFor: () => ({ [RESOURCE]: { scopes: ["read"] } }),
});
const app = createApp({ oauth: issuers });
const url = (path: string) => `${issuerOf("acme", origin)}${path}`;
const tenants = new TenantsService(mongo.db.tenants, {
  onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
});

const gql = async (query: string, variables = {}, cookie = "") => {
  const response = await app.request(url("/graphql"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie === "" ? {} : { cookie }),
    },
    body: JSON.stringify({ query, variables }),
  });
  return {
    body: (await response.json()) as {
      data?: Record<string, Record<string, string>>;
      errors?: unknown;
    },
    cookies: response.headers.getSetCookie(),
  };
};

let secret = "";

beforeAll(async () => {
  await createTenantParOff(tenants, { slug: "acme", name: "Acme" });
  const tenant = await tenantResolver.resolveHost(new URL(url("/")).host);
  if (tenant === null) throw new Error("no tenant");
  await rotateSigningKeys(keys, {
    now: new Date(),
    lead: "1h",
    retireAfter: "2h",
  });
  const registered = await registerClient(
    { db: oauthDb, findTenant: (s) => mongo.db.tenants.findFirst({ slug: s }) },
    {
      tenant: "acme",
      name: "Back end",
      clientId: "backend",
      redirectUris: [REDIRECT],
      type: "confidential",
    },
  );
  secret = registered.clientSecret ?? "";
});

afterAll(async () => {
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

test("auth_time is present in the id_token after a passkey sign-in", async () => {
  const tenant = await tenantResolver.resolveHost(new URL(url("/")).host);
  if (tenant === null) throw new Error("no tenant");
  const auth = await janusIssuers.forRequest(new Request(url("/")));
  if (auth === null) throw new Error("no janus");
  const user = await auth.create({ email: "ada@example.test" });
  await auth.verifyEmail.confirm((await auth.verifyEmail.send(user)).token);
  const first = await auth.signInProven((await auth.findUser(user.id)) ?? user);
  if (first.status !== "signedIn") throw new Error("no session");

  // Register a passkey, then sign in with it alone.
  const authenticator = await softwareAuthenticator();
  const asked = await auth.passkeys.registrationOptions(user);
  const current = await auth.authenticate(
    new Request(url("/"), {
      headers: { cookie: `${SESSION_COOKIE}=${first.token}` },
    }),
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
  const issued = await gql(
    "mutation { passkeySignInOptions { options challenge } }",
  );
  const { options = "", challenge = "" } =
    issued.body.data?.["passkeySignInOptions"] ?? {};
  await Bun.sleep(1100); // the sign-in time differs from the first session's
  const signedIn = await gql(
    "mutation ($c: String!, $r: String!) { signInWithPasskey(challenge: $c, response: $r) { expiresAt } }",
    {
      c: challenge,
      r: JSON.stringify(
        await authenticator.assert({
          challenge: String(
            (JSON.parse(options) as { challenge: string }).challenge,
          ),
          origin: originOf(tenant),
          rpId: rpIdOf(tenant),
          userHandle: Buffer.from(user.id).toString("base64url"),
        }),
      ),
    },
  );
  expect(signedIn.body.errors).toBeUndefined();
  const header = signedIn.cookies.find((c) =>
    c.startsWith(`${SESSION_COOKIE}=`),
  );
  const cookie = header?.split(";")[0] ?? "";
  const session = await auth.authenticate(
    new Request(url("/"), { headers: { cookie } }),
  );
  if (session === null) throw new Error("passkey session is anonymous");

  // /authorize, approve, token.
  const authorize = await issuers.handle(
    new Request(
      url(
        `/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: "backend",
          redirect_uri: REDIRECT,
          code_challenge: await s256Challenge(VERIFIER),
          code_challenge_method: "S256",
          scope: "openid email",
          nonce: "n-0S6_WzA2Mj",
          state: "xyz",
        })}`,
      ),
    ),
  );
  const requestId =
    new URL(authorize.headers.get("location") ?? "", url("/")).searchParams.get(
      "request_id",
    ) ?? "";
  const approved = await gql(
    "mutation ($id: ID!) { approveOAuthRequest(id: $id) { redirectTo } }",
    { id: requestId },
    cookie,
  );
  expect(approved.body.errors).toBeUndefined();
  const redirectTo =
    approved.body.data?.["approveOAuthRequest"]?.["redirectTo"];
  const token = await issuers.handle(
    new Request(url("/token"), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`backend:${secret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(redirectTo ?? "").searchParams.get("code") ?? "",
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
    }),
  );
  expect(token.status).toBe(200);
  const { id_token } = (await token.json()) as { id_token: string };
  expect(decodeJwt(id_token)["auth_time"]).toBe(
    Math.floor(session.session.authenticatedAt.getTime() / 1000),
  );
  expect(session.session.authenticatedAt.getTime()).toBeGreaterThan(
    first.session.authenticatedAt.getTime() + 1000,
  );
});
