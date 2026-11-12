import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { decodeJwt } from "jose";
import { createApp } from "@/app";
import { registerClient } from "@/clients/register-client";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { TenantsService } from "@/modules/tenants/tenants.service";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { createTenantResolver } from "@/tenancy/resolver";
import { noTenantCache } from "@/tenancy/tenant-cache";
import { createTenantAuth } from "@/users/tenant-auth";
import { SESSION_COOKIE } from "@/users/tenant-janus";
import { CONSENT_GRAPHQL_PATH, createConsentYoga } from "./consent-yoga";

const DOMAIN = "clavix.test";
const RESOURCE = "https://api.clavix.test/mcp";
const REDIRECT = "https://app.example/callback";
const VERIFIER = "v".repeat(64);
const config = { scheme: "https", domain: DOMAIN } as const;

const resolver = createTenantResolver({
  lookup: (slug) => mongo.db.tenants.findFirst({ slug }),
  cache: noTenantCache,
  config,
});
const tenants = new TenantsService(mongo.db.tenants, {
  domain: DOMAIN,
  onHostsChanged: (hosts) => resolver.invalidate(hosts),
});
const { janusIssuers, authFor, claimsFor } = createTenantAuth({
  resolver,
  db: oauthDb,
});
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
  resolver,
  db: oauthDb,
  signingKeysFor,
  authFor,
  claimsFor,
  resourcesFor: () => ({ [RESOURCE]: { scopes: ["read"] } }),
});
const yoga = createConsentYoga({ issuers, janusIssuers });

const url = (slug: string, path = "/") => `https://${slug}.${DOMAIN}${path}`;
const basic = (id: string, secret: string) =>
  `Basic ${btoa(`${id}:${secret}`)}`;

interface GqlResult {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}
const gql = async (
  slug: string,
  query: string,
  variables: Record<string, unknown>,
  cookie?: string,
): Promise<GqlResult> => {
  const response = await yoga.fetch(
    new Request(url(slug, CONSENT_GRAPHQL_PATH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify({ query, variables }),
    }),
  );
  return (await response.json()) as GqlResult;
};
const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions?.code;

const REQUEST = `query($id: ID!) { oauthRequest(id: $id) { id client { id name } redirectHost resource scopes { name label } } }`;
const APPROVE = `mutation($id: ID!, $scopes: [String!]) { approveOAuthRequest(id: $id, scopes: $scopes) { redirectTo grantId } }`;
const DENY = `mutation($id: ID!) { denyOAuthRequest(id: $id) { redirectTo grantId } }`;

const clients: Record<string, { id: string; secret: string }> = {};
const sessions: Record<string, { cookie: string; authenticatedAt: Date }> = {};

// authorize on the tenant's issuer: the pending request's id.
async function authorize(slug: string, scope = "openid email") {
  const client = clients[slug] as { id: string; secret: string };
  const response = await issuers.handle(
    new Request(
      url(
        slug,
        `/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: client.id,
          redirect_uri: REDIRECT,
          code_challenge: await s256Challenge(VERIFIER),
          code_challenge_method: "S256",
          scope,
          nonce: "n-0S6_WzA2Mj",
          state: "xyz",
        })}`,
      ),
    ),
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "", url(slug));
  expect(location.href).toContain("/consent");
  return location.searchParams.get("request_id") ?? "";
}

async function exchange(slug: string, redirectTo: string) {
  const client = clients[slug] as { id: string; secret: string };
  return issuers.handle(
    new Request(url(slug, "/token"), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic(client.id, client.secret),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(redirectTo).searchParams.get("code") ?? "",
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
    }),
  );
}

beforeAll(async () => {
  for (const slug of ["acme", "globex"]) {
    await tenants.create({ slug, name: slug });
    const tenant = await resolver.resolveHost(`${slug}.${DOMAIN}`);
    if (tenant === null) throw new Error("tenant not resolved");
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
      },
    );
    clients[slug] = { id: "backend", secret: registered.clientSecret ?? "" };
    const auth = await janusIssuers.forRequest(new Request(url(slug)));
    if (auth === null) throw new Error("no janus");
    const user = await auth.create({ email: "ada@example.test" });
    const result = await auth.signInProven(user);
    if (result.status !== "signedIn") throw new Error("no session");
    sessions[slug] = {
      cookie: `${SESSION_COOKIE}=${result.token}`,
      authenticatedAt: result.session.authenticatedAt,
    };
  }
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await oauthDb.collection("partitionedUsers").deleteMany({});
  await oauthDb.collection("partitionedSessions").deleteMany({});
});

const cookieOf = (slug: string) => sessions[slug]?.cookie ?? "";

describe("the consent screen's data", () => {
  test("oauthRequest shows the client, the redirect host and the scopes", async () => {
    const id = await authorize("acme");
    const result = await gql("acme", REQUEST, { id }, cookieOf("acme"));
    expect(result.errors).toBeUndefined();
    expect(result.data?.["oauthRequest"]).toMatchObject({
      id,
      client: { id: "backend", name: "Back end" },
      redirectHost: "app.example",
    });
  });

  test("an anonymous viewer is UNAUTHENTICATED", async () => {
    const id = await authorize("acme");
    const result = await gql("acme", REQUEST, { id });
    expect(codeOf(result)).toBe("UNAUTHENTICATED");
  });
});

describe("approve", () => {
  test("ends with an id_token whose auth_time is the session's sign-in time, with no amr", async () => {
    const id = await authorize("acme");
    const approved = await gql("acme", APPROVE, { id }, cookieOf("acme"));
    expect(approved.errors).toBeUndefined();
    const decision = approved.data?.["approveOAuthRequest"] as {
      redirectTo: string;
    };
    const response = await exchange("acme", decision.redirectTo);
    expect(response.status).toBe(200);
    const { id_token } = (await response.json()) as { id_token: string };
    const claims = decodeJwt(id_token);
    const signedInAt = sessions["acme"]?.authenticatedAt ?? new Date(0);
    expect(claims["auth_time"]).toBe(Math.floor(signedInAt.getTime() / 1000));
    // janus-oauth's resolvers pass no amr/acr (README, "Consent").
    expect(claims["amr"]).toBeUndefined();
    expect(claims["acr"]).toBeUndefined();
  });

  test("a session older than five minutes is STEP_UP_REQUIRED and the request stays pending", async () => {
    const auth = await janusIssuers.forRequest(new Request(url("acme")));
    const user = await auth?.create({ email: "old@example.test" });
    const result = await auth?.signInProven(user as never);
    if (result?.status !== "signedIn") throw new Error("no session");
    await oauthDb
      .collection("partitionedSessions")
      .updateMany(
        { userId: user?.id },
        { $set: { authenticatedAt: new Date(Date.now() - 10 * 60_000) } },
      );
    const cookie = `${SESSION_COOKIE}=${result.token}`;
    const id = await authorize("acme");
    const refused = await gql("acme", APPROVE, { id }, cookie);
    expect(codeOf(refused)).toBe("STEP_UP_REQUIRED");
    // Still pending, and the fresh session can decide it.
    const read = await gql("acme", REQUEST, { id }, cookie);
    expect(read.errors).toBeUndefined();
    const approved = await gql("acme", APPROVE, { id }, cookieOf("acme"));
    expect(approved.errors).toBeUndefined();
  });
});

describe("deny", () => {
  test("redirects to the client with access_denied and the state", async () => {
    const id = await authorize("acme");
    const denied = await gql("acme", DENY, { id }, cookieOf("acme"));
    expect(denied.errors).toBeUndefined();
    const { redirectTo, grantId } = denied.data?.["denyOAuthRequest"] as {
      redirectTo: string;
      grantId: string | null;
    };
    const target = new URL(redirectTo);
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("xyz");
    expect(grantId).toBeNull();
    // Decided: gone.
    const again = await gql("acme", REQUEST, { id }, cookieOf("acme"));
    expect(codeOf(again)).toBe("NOT_FOUND");
  });
});

describe("tenant isolation", () => {
  test("a request id of A is NOT_FOUND on B for read, approve and deny, even with B's session", async () => {
    const id = await authorize("acme");
    for (const [query, name] of [
      [REQUEST, "oauthRequest"],
      [APPROVE, "approveOAuthRequest"],
      [DENY, "denyOAuthRequest"],
    ] as const) {
      const result = await gql("globex", query, { id }, cookieOf("globex"));
      expect(codeOf(result), name).toBe("NOT_FOUND");
    }
    // Untouched on A.
    const onA = await gql("acme", REQUEST, { id }, cookieOf("acme"));
    expect(onA.errors).toBeUndefined();
  });

  test("A's session is anonymous on B", async () => {
    const id = await authorize("globex");
    const result = await gql("globex", REQUEST, { id }, cookieOf("acme"));
    expect(codeOf(result)).toBe("UNAUTHENTICATED");
  });
});

describe("mounted on the app", () => {
  test("POST /graphql/consent answers on the tenant's host", async () => {
    const id = await authorize("acme");
    const app = createApp({ oauth: issuers, consent: yoga });
    const response = await app.request(url("acme", CONSENT_GRAPHQL_PATH), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieOf("acme") },
      body: JSON.stringify({ query: REQUEST, variables: { id } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as GqlResult;
    expect(body.errors).toBeUndefined();
    expect(body.data?.["oauthRequest"]).toMatchObject({ id });
  });
});
