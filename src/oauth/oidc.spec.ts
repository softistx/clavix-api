import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { registerClient } from "@/modules/clients";
import { PLATFORM_TENANT_SLUG, TenantsService } from "@/modules/tenants";
import { createTenantResolver } from "@/tenancy/resolver";
import { noTenantCache } from "@/tenancy/tenant-cache";
import { noCustomDomains, quietOAuth, quietTenants } from "~/ports";
import { createTenantParOff } from "../../test/tenant-par-off";
import { createClavixOAuthIssuers, userinfoOf } from "./issuers";
import type { AuthFor, ClaimsFor, SigningKeysFor } from "./ports";

const DOMAIN = "clavix.test";
const RESOURCE = "https://api.clavix.test/mcp";
const REDIRECT = "https://app.example/callback";
const VERIFIER = "v".repeat(64);
const config = { scheme: "https", domain: DOMAIN } as const;
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });

const resolver = createTenantResolver({
  ...noCustomDomains,
  log: () => {},
  lookup: findTenant,
  cache: noTenantCache,
  config,
});
const tenants = new TenantsService(mongo.db.tenants, {
  ...quietTenants,
  now: () => new Date(),
  log: () => {},
  domain: DOMAIN,
  onHostsChanged: (hosts) => resolver.invalidate(hosts),
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
const authFor: AuthFor = (tenant) => {
  const id = `user-${tenant.slug}`;
  return {
    authenticate: async () => ({
      via: "session" as const,
      user: { id },
      session: { authenticatedAt: new Date(), userId: id },
    }),
    findUser: async (userId) => (userId === id ? { id, active: true } : null),
  };
};
// The fake user pool: every claim the tenant knows, whatever the scopes.
const claimsFor: ClaimsFor = (tenant) => async (subject) => ({
  name: `Name of ${tenant.slug}`,
  family_name: "Doe",
  email: `${subject.id}@${tenant.slug}.test`,
  email_verified: true,
  phone_number: "+15550100",
});

const issuers = createClavixOAuthIssuers({
  ...quietOAuth,
  clock: { now: () => new Date() },
  dpopNonceSecret: "spec-dpop-nonce-secret",
  resolver,
  db: oauthDb,
  signingKeysFor,
  authFor,
  claimsFor,
  resourcesFor: () => ({ [RESOURCE]: { scopes: ["read"] } }),
});

const url = (slug: string, path: string) => `https://${slug}.${DOMAIN}${path}`;
const issuerOf = (slug: string) => url(slug, "");
const get = (slug: string, path: string, authorization?: string) =>
  issuers.handle(
    new Request(url(slug, path), {
      headers: authorization === undefined ? {} : { authorization },
    }),
  );
const post = (
  slug: string,
  path: string,
  body: Record<string, string>,
  authorization?: string,
) =>
  issuers.handle(
    new Request(url(slug, path), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: new URLSearchParams(body),
    }),
  );
const basic = (id: string, secret: string) =>
  `Basic ${btoa(`${id}:${secret}`)}`;

const clients: Record<string, { id: string; secret: string }> = {};

async function setUp(slug: string, withKey = true) {
  await createTenantParOff(tenants, { slug, name: slug });
  const tenant = await resolver.resolveHost(`${slug}.${DOMAIN}`);
  if (tenant === null) throw new Error("tenant not resolved");
  if (withKey) {
    await rotateSigningKeys(signingKeysFor(tenant.tenantId), {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
  }
  const registered = await registerClient(
    { now: () => new Date(), db: oauthDb, findTenant },
    {
      tenant: slug,
      name: "Back end",
      clientId: "backend",
      redirectUris: [REDIRECT],
      type: "confidential",
    },
  );
  clients[slug] = { id: "backend", secret: registered.clientSecret ?? "" };
}

// authorize, approve as the tenant's fixed user, then the code exchange. No
// `resource`: the issuer's default (its userinfo) applies.
async function login(
  slug: string,
  scope: string,
  resource?: string,
  nonce = "n-0S6_WzA2Mj",
) {
  const client = clients[slug] as { id: string; secret: string };
  const authorize = await get(
    slug,
    `/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.id,
      redirect_uri: REDIRECT,
      code_challenge: await s256Challenge(VERIFIER),
      code_challenge_method: "S256",
      scope,
      nonce,
      ...(resource === undefined ? {} : { resource }),
      state: "xyz",
    })}`,
  );
  expect(authorize.status).toBe(302);
  const consent = new URL(
    authorize.headers.get("location") ?? "",
    url(slug, "/"),
  );
  const server = await issuers.serverFor(new Request(url(slug, "/")));
  if (server === null) throw new Error(`no server for ${slug}`);
  const { redirectTo } = await server.approve(
    { id: `user-${slug}` },
    consent.searchParams.get("request_id") ?? "",
    { scopes: scope.split(" "), authTime: new Date() },
  );
  return post(
    slug,
    "/token",
    {
      grant_type: "authorization_code",
      code: new URL(redirectTo).searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      ...(resource === undefined ? {} : { resource }),
    },
    basic(client.id, client.secret),
  );
}

interface Tokens {
  access_token: string;
  id_token: string;
}
const tokensOf = async (slug: string, scope: string) => {
  const response = await login(slug, scope);
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
};
const jwksOf = async (slug: string) =>
  createLocalJWKSet(
    (await (await get(slug, "/jwks.json")).json()) as Parameters<
      typeof createLocalJWKSet
    >[0],
  );

beforeAll(async () => {
  await setUp("acme");
  await setUp("globex");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
});

describe("discovery", () => {
  test("is the tenant's own, with its endpoints and its keys", async () => {
    const response = await get("acme", "/.well-known/openid-configuration");
    expect(response.status).toBe(200);
    const document = (await response.json()) as Record<string, unknown>;
    expect(document).toMatchObject({
      issuer: issuerOf("acme"),
      authorization_endpoint: url("acme", "/authorize"),
      token_endpoint: url("acme", "/token"),
      jwks_uri: url("acme", "/jwks.json"),
      userinfo_endpoint: userinfoOf(issuerOf("acme")),
      introspection_endpoint: url("acme", "/introspect"),
    });
    expect(document["scopes_supported"]).toEqual(
      expect.arrayContaining(["openid", "profile", "email"]),
    );
    expect(document["id_token_signing_alg_values_supported"]).toEqual([
      "ES256",
    ]);
  });

  test("an unknown host is a 404", async () => {
    const response = await get("nobody", "/.well-known/openid-configuration");
    expect(response.status).toBe(404);
  });
});

describe("id_token", () => {
  test("is signed with the tenant's current key and verifies against its JWKS", async () => {
    const tokens = await tokensOf("acme", "openid profile email");
    const { payload, protectedHeader } = await jwtVerify(
      tokens.id_token,
      await jwksOf("acme"),
      { issuer: issuerOf("acme"), audience: "backend" },
    );
    const tenant = await resolver.resolveHost(`acme.${DOMAIN}`);
    const current = await signingKeysFor(tenant?.tenantId ?? "").findCurrentKey(
      new Date(),
    );
    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.kid).toBe(current?.kid ?? "");
    expect(payload).toMatchObject({ sub: "user-acme", nonce: "n-0S6_WzA2Mj" });
    expect(typeof payload["auth_time"]).toBe("number");
    // at_hash: the left half of the SHA-256 of the access token (ES256).
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(tokens.access_token),
    );
    expect(payload["at_hash"]).toBe(
      Buffer.from(digest.slice(0, 16)).toString("base64url"),
    );
  });

  test("is not issued without the openid scope", async () => {
    const response = await login("acme", "profile");
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("id_token");
  });

  test("a tenant with no signing key answers 503, and recovers with its first key", async () => {
    await setUp("nokey", false);
    const failed = await login("nokey", "openid");
    expect(failed.status).toBe(503);
    // Discovery needs no key: it announces ES256 until the first one.
    expect(
      (await get("nokey", "/.well-known/openid-configuration")).status,
    ).toBe(200);
    const tenant = await resolver.resolveHost(`nokey.${DOMAIN}`);
    await rotateSigningKeys(signingKeysFor(tenant?.tenantId ?? ""), {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
    expect((await login("nokey", "openid")).status).toBe(200);
  });
});

describe("userinfo", () => {
  test("openid releases the subject only", async () => {
    const tokens = await tokensOf("acme", "openid");
    const response = await get(
      "acme",
      "/userinfo",
      `Bearer ${tokens.access_token}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sub: "user-acme" });
  });

  test("profile and email release their claims, read in the tenant's user pool", async () => {
    const tokens = await tokensOf("acme", "openid profile email");
    const response = await get(
      "acme",
      "/userinfo",
      `Bearer ${tokens.access_token}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sub: "user-acme",
      name: "Name of acme",
      family_name: "Doe",
      email: "user-acme@acme.test",
      email_verified: true,
    });
  });

  test("each tenant's userinfo reads its own user pool", async () => {
    const tokens = await tokensOf("globex", "openid email");
    const response = await get(
      "globex",
      "/userinfo",
      `Bearer ${tokens.access_token}`,
    );
    expect(await response.json()).toEqual({
      sub: "user-globex",
      email: "user-globex@globex.test",
      email_verified: true,
    });
  });

  test("no token is a 401", async () => {
    expect((await get("acme", "/userinfo")).status).toBe(401);
  });
});

describe("introspection", () => {
  test("answers active for a token of the tenant's own resource", async () => {
    const response = await login("acme", "read", RESOURCE);
    const { access_token } = (await response.json()) as Tokens;
    const client = clients["acme"] as { id: string; secret: string };
    const introspected = await post(
      "acme",
      "/introspect",
      { token: access_token },
      basic(client.id, client.secret),
    );
    expect(await introspected.json()).toMatchObject({
      active: true,
      scope: "read",
      sub: "user-acme",
      iss: issuerOf("acme"),
    });
  });

  test("needs a confidential client of the tenant, and shows nothing of tokens for other resources", async () => {
    const tokens = await tokensOf("acme", "openid");
    const client = clients["acme"] as { id: string; secret: string };
    const anonymous = await post("acme", "/introspect", {
      token: tokens.access_token,
    });
    expect(anonymous.status).toBe(401);
    // The token is for the userinfo resource, not one of the tenant's own:
    // inactive to a resource server (RFC 7662 section 4).
    const response = await post(
      "acme",
      "/introspect",
      { token: tokens.access_token },
      basic(client.id, client.secret),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: false });
  });
});

describe("tenant isolation", () => {
  test("A's id_token does not verify against B's JWKS", async () => {
    const tokens = await tokensOf("acme", "openid");
    await expect(
      jwtVerify(tokens.id_token, await jwksOf("globex")),
    ).rejects.toThrow();
    const kid = decodeProtectedHeader(tokens.id_token).kid;
    const globex = (await (await get("globex", "/jwks.json")).json()) as {
      keys: { kid: string }[];
    };
    expect(globex.keys.map((key) => key.kid)).not.toContain(kid);
  });

  test("A's access token is refused at B's userinfo", async () => {
    const tokens = await tokensOf("acme", "openid profile");
    const response = await get(
      "globex",
      "/userinfo",
      `Bearer ${tokens.access_token}`,
    );
    expect(response.status).toBe(401);
  });

  test("B's discovery does not show A's issuer", async () => {
    const text = await (
      await get("globex", "/.well-known/openid-configuration")
    ).text();
    expect(text).toContain(issuerOf("globex"));
    expect(text).not.toContain(issuerOf("acme"));
  });

  test("A's client secret does not authenticate at B's introspection", async () => {
    const tokens = await tokensOf("acme", "openid");
    const client = clients["acme"] as { id: string; secret: string };
    // Same client id on both tenants, but A's secret: B's partition refuses.
    const response = await post(
      "globex",
      "/introspect",
      { token: tokens.access_token },
      basic(client.id, client.secret),
    );
    expect(response.status).toBe(401);
  });
});
