import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  type OAuthServer,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { PLATFORM_TENANT_SLUG, TenantsService } from "@/modules/tenants";
import { createTenantResolver } from "@/tenancy/resolver";
import { noTenantCache } from "@/tenancy/tenant-cache";
import { noCustomDomains, quietOAuth, quietTenants } from "~/ports";
import { createTenantParOff } from "../../test/tenant-par-off";
import { createClavixOAuthIssuers } from "./issuers";
import type { AuthFor, SigningKeysFor } from "./ports";
import { resolveIssuer } from "./resolution";

const DOMAIN = "clavix.test";
const RESOURCE = "https://api.clavix.test/mcp";
const NO_SCOPE_RESOURCE = "https://api.clavix.test/empty";
const REDIRECT = "https://app.example/callback";
const config = { scheme: "https", domain: DOMAIN } as const;

const resolver = createTenantResolver({
  ...noCustomDomains,
  log: () => {},
  lookup: (slug) => mongo.db.tenants.findFirst({ slug }),
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

// The in-memory keys a tenant signs with, one store per tenant; `builds`
// counts the servers janus built (the port is asked once per build).
const keys = new Map<string, SigningKeyStore>();
const builds: string[] = [];
const signingKeysFor: SigningKeysFor = (tenantId) => {
  builds.push(tenantId);
  let store = keys.get(tenantId);
  if (store === undefined) {
    store = createMemorySigningKeys();
    keys.set(tenantId, store);
  }
  return store;
};
// Signs in a fixed user per tenant.
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

// A stored resource with no scope: left out, it must not crash the server.
const resourcesFor = () => ({
  [RESOURCE]: { scopes: ["read", "write"] },
  [NO_SCOPE_RESOURCE]: { scopes: [] },
});
const issuers = createClavixOAuthIssuers({
  ...quietOAuth,
  clock: { now: () => new Date() },
  dpopNonceSecret: "spec-dpop-nonce-secret",
  resolver,
  db: oauthDb,
  signingKeysFor,
  authFor,
  claimsFor: () => async () => ({}),
  resourcesFor,
});

const url = (slug: string, path: string) => `https://${slug}.${DOMAIN}${path}`;
const get = (slug: string, path: string) =>
  issuers.handle(new Request(url(slug, path)));
const post = (slug: string, path: string, body: Record<string, string>) =>
  issuers.handle(
    new Request(url(slug, path), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    }),
  );
const serverOf = async (slug: string): Promise<OAuthServer> => {
  const server = await issuers.serverFor(new Request(url(slug, "/")));
  if (server === null) throw new Error(`no server for ${slug}`);
  return server;
};

const VERIFIER = "v".repeat(64);

// Runs authorize, then approves as the tenant's fixed user; answers the code.
async function codeFor(slug: string, clientId: string): Promise<string> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await s256Challenge(VERIFIER),
    code_challenge_method: "S256",
    scope: "read",
    resource: RESOURCE,
    state: "xyz",
  });
  const authorize = await get(slug, `/authorize?${query}`);
  expect(authorize.status).toBe(302);
  const consent = new URL(
    authorize.headers.get("location") ?? "",
    url(slug, "/"),
  );
  expect(consent.pathname).toBe("/consent");
  const requestId = consent.searchParams.get("request_id") ?? "";
  const server = await serverOf(slug);
  const { redirectTo } = await server.approve(
    { id: `user-${slug}` },
    requestId,
    { scopes: ["read"] },
  );
  const redirected = new URL(redirectTo);
  expect(redirected.searchParams.get("state")).toBe("xyz");
  expect(redirected.searchParams.get("iss")).toBe(`https://${slug}.${DOMAIN}`);
  return redirected.searchParams.get("code") ?? "";
}

const exchange = (slug: string, clientId: string, code: string) =>
  post(slug, "/token", {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: RESOURCE,
  });
const refresh = (slug: string, clientId: string, token: string) =>
  post(slug, "/token", {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: token,
  });

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}
const clients: Record<string, string> = {};

async function setUp(slug: string) {
  await createTenantParOff(tenants, { slug, name: slug });
  const tenant = await resolver.resolveHost(`${slug}.${DOMAIN}`);
  if (tenant === null) throw new Error("tenant not resolved");
  const store = signingKeysFor(tenant.tenantId);
  await rotateSigningKeys(store, {
    now: new Date(),
    lead: "1h",
    retireAfter: "2h",
  });
  const server = await serverOf(slug);
  const { client } = await server.createClient({
    name: `App of ${slug}`,
    redirectUris: [REDIRECT],
  });
  clients[slug] = client.id;
}

beforeAll(async () => {
  await setUp("acme");
  await setUp("globex");
  builds.length = 0;
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
});

describe("authorization code with PKCE", () => {
  test("the full flow ends in a JWT access token of 15 minutes and a refresh token", async () => {
    const code = await codeFor("acme", clients["acme"] as string);
    const response = await exchange("acme", clients["acme"] as string, code);
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as Tokens;
    expect(tokens.expires_in).toBe(15 * 60);
    expect(tokens.access_token.split(".")).toHaveLength(3);
    const server = await serverOf("acme");
    const who = await server.authenticate(
      new Request(url("acme", "/"), {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
      { resource: RESOURCE },
    );
    expect(who).toMatchObject({ userId: "user-acme", scopes: ["read"] });
  });

  test("a wrong verifier is refused and a code is single-use", async () => {
    const code = await codeFor("acme", clients["acme"] as string);
    const wrong = await post("acme", "/token", {
      grant_type: "authorization_code",
      client_id: clients["acme"] as string,
      code,
      redirect_uri: REDIRECT,
      code_verifier: "w".repeat(64),
      resource: RESOURCE,
    });
    expect(wrong.status).toBe(400);
    const good = await exchange("acme", clients["acme"] as string, code);
    expect(good.status).toBe(400);
  });
});

describe("refresh tokens", () => {
  test("rotate on every use", async () => {
    const code = await codeFor("acme", clients["acme"] as string);
    const first = (await (
      await exchange("acme", clients["acme"] as string, code)
    ).json()) as Tokens;
    const second = await refresh(
      "acme",
      clients["acme"] as string,
      first.refresh_token,
    );
    expect(second.status).toBe(200);
    const rotated = (await second.json()) as Tokens;
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    expect(rotated.access_token).not.toBe(first.access_token);
  });

  test("a reused refresh token revokes the whole grant", async () => {
    const code = await codeFor("acme", clients["acme"] as string);
    const first = (await (
      await exchange("acme", clients["acme"] as string, code)
    ).json()) as Tokens;
    const second = (await (
      await refresh("acme", clients["acme"] as string, first.refresh_token)
    ).json()) as Tokens;
    const reuse = await refresh(
      "acme",
      clients["acme"] as string,
      first.refresh_token,
    );
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ error: "invalid_grant" });
    // The newest token went with the grant, and so did the access tokens.
    const newest = await refresh(
      "acme",
      clients["acme"] as string,
      second.refresh_token,
    );
    expect(newest.status).toBe(400);
    const server = await serverOf("acme");
    expect(
      await server.authenticate(
        new Request(url("acme", "/"), {
          headers: { authorization: `Bearer ${second.access_token}` },
        }),
        { resource: RESOURCE },
      ),
    ).toBeNull();
  });
});

describe("a client's grant types (janus-oauth enforces them)", () => {
  test("a client without refresh_token gets its first tokens but cannot refresh", async () => {
    const server = await serverOf("acme");
    const { client } = await server.createClient({
      name: "Code only",
      redirectUris: [REDIRECT],
      grantTypes: ["authorization_code"],
    });
    const code = await codeFor("acme", client.id);
    const exchanged = await exchange("acme", client.id, code);
    expect(exchanged.status).toBe(200);
    const tokens = (await exchanged.json()) as Tokens;
    const refused = await refresh("acme", client.id, tokens.refresh_token);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: "unauthorized_client",
    });
  });

  test("a client that lists refresh_token refreshes", async () => {
    const server = await serverOf("acme");
    const { client } = await server.createClient({
      name: "Code and refresh",
      redirectUris: [REDIRECT],
      grantTypes: ["authorization_code", "refresh_token"],
    });
    const tokens = (await (
      await exchange("acme", client.id, await codeFor("acme", client.id))
    ).json()) as Tokens;
    expect(
      (await refresh("acme", client.id, tokens.refresh_token)).status,
    ).toBe(200);
  });

  test("a client without authorization_code cannot use the code grant", async () => {
    const server = await serverOf("acme");
    await expect(
      server.createClient({
        name: "Refresh only",
        redirectUris: [REDIRECT],
        grantTypes: ["refresh_token"],
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("revocation", () => {
  test("revoking a refresh token ends its use", async () => {
    const code = await codeFor("acme", clients["acme"] as string);
    const tokens = (await (
      await exchange("acme", clients["acme"] as string, code)
    ).json()) as Tokens;
    const revoked = await post("acme", "/revoke", {
      client_id: clients["acme"] as string,
      token: tokens.refresh_token,
    });
    expect(revoked.status).toBe(200);
    const after = await refresh(
      "acme",
      clients["acme"] as string,
      tokens.refresh_token,
    );
    expect(after.status).toBe(400);
  });
});

describe("metadata", () => {
  test("each host announces its own issuer and endpoints", async () => {
    for (const slug of ["acme", "globex"]) {
      const response = await get(
        slug,
        "/.well-known/oauth-authorization-server",
      );
      expect(response.status).toBe(200);
      const metadata = (await response.json()) as Record<string, unknown>;
      expect(metadata["issuer"]).toBe(`https://${slug}.${DOMAIN}`);
      expect(metadata["token_endpoint"]).toBe(
        `https://${slug}.${DOMAIN}/token`,
      );
      expect(metadata["jwks_uri"]).toBe(`https://${slug}.${DOMAIN}/jwks.json`);
    }
  });
});

describe("a resource with no scope", () => {
  test("is left out and the tenant's server still builds and serves", async () => {
    const response = await get(
      "acme",
      "/.well-known/oauth-authorization-server",
    );
    expect(response.status).toBe(200);
    const server = await serverOf("acme");
    expect(server).toBeDefined();
  });

  test("is absent from what resolve answers, so from the server and the introspection list", async () => {
    const keyed = await resolveIssuer(
      resolver,
      resourcesFor,
    )(new Request(url("acme", "/")));
    expect(Object.keys(keyed?.resources ?? {})).toEqual([RESOURCE]);
  });
});

describe("unknown and suspended hosts", () => {
  test("an unknown tenant, the apex and a foreign host are 404", async () => {
    for (const host of [`nobody.${DOMAIN}`, DOMAIN, "elsewhere.example"]) {
      const response = await issuers.handle(
        new Request(`https://${host}/.well-known/oauth-authorization-server`),
      );
      expect(response.status).toBe(404);
    }
  });

  test("a suspended tenant keeps its discovery (tokens already issued live to expiry)", async () => {
    await createTenantParOff(tenants, { slug: "paused", name: "Paused" });
    const path = "/.well-known/oauth-authorization-server";
    expect((await get("paused", path)).status).toBe(200);
    const tenant = await resolver.resolveHost(`paused.${DOMAIN}`);
    await tenants.suspend(tenant?.tenantId ?? "");
    expect((await get("paused", path)).status).toBe(200);
    await tenants.reactivate(tenant?.tenantId ?? "");
    expect((await get("paused", path)).status).toBe(200);
  });
});

describe("rebuild on tenant change", () => {
  test("a server is built once and rebuilt after a tenant write", async () => {
    const tenant = await resolver.resolveHost(`globex.${DOMAIN}`);
    const id = tenant?.tenantId ?? "";
    builds.length = 0;
    await get("globex", "/.well-known/oauth-authorization-server");
    await get("globex", "/.well-known/oauth-authorization-server");
    expect(builds.filter((b) => b === id)).toHaveLength(0); // already cached
    await tenants.suspend(id);
    await tenants.reactivate(id); // two writes: the version moved
    await get("globex", "/.well-known/oauth-authorization-server");
    await get("globex", "/.well-known/oauth-authorization-server");
    expect(builds.filter((b) => b === id)).toHaveLength(1);
  });
});

describe("tenant isolation", () => {
  test("A's code, tokens and client are refused on B", async () => {
    const acme = clients["acme"] as string;
    const globex = clients["globex"] as string;
    const code = await codeFor("acme", acme);

    // The code, with A's client and with B's.
    for (const clientId of [acme, globex]) {
      const stolen = await exchange("globex", clientId, code);
      expect(stolen.status).toBeGreaterThanOrEqual(400);
    }
    // A's client is unknown on B: authorize cannot even start.
    const query = new URLSearchParams({
      response_type: "code",
      client_id: acme,
      redirect_uri: REDIRECT,
      code_challenge: await s256Challenge(VERIFIER),
      code_challenge_method: "S256",
      resource: RESOURCE,
    });
    expect((await get("globex", `/authorize?${query}`)).status).toBe(400);

    const tokens = (await (
      await exchange("acme", acme, code)
    ).json()) as Tokens;
    // The refresh token, and the access token, on B.
    expect((await refresh("globex", acme, tokens.refresh_token)).status).toBe(
      400,
    );
    const onGlobex = await serverOf("globex");
    expect(
      await onGlobex.authenticate(
        new Request(url("globex", "/"), {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
        { resource: RESOURCE },
      ),
    ).toBeNull();
    // And A's token still works on A.
    const onAcme = await serverOf("acme");
    expect(
      await onAcme.authenticate(
        new Request(url("acme", "/"), {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
        { resource: RESOURCE },
      ),
    ).not.toBeNull();
  });
});

describe("a tenant without a signing key yet", () => {
  test("the token endpoint fails cleanly, spending no code", async () => {
    await createTenantParOff(tenants, { slug: "nokey", name: "No key" });
    const server = await serverOf("nokey");
    const { client } = await server.createClient({
      name: "App",
      redirectUris: [REDIRECT],
    });
    const code = await codeFor("nokey", client.id);
    const failed = await exchange("nokey", client.id, code);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      error: "temporarily_unavailable",
    });
    // The code was not spent: once the key exists, the same code exchanges.
    const tenant = await resolver.resolveHost(`nokey.${DOMAIN}`);
    await rotateSigningKeys(signingKeysFor(tenant?.tenantId ?? ""), {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
    expect((await exchange("nokey", client.id, code)).status).toBe(200);
  });
});
