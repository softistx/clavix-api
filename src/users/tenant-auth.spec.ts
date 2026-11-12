import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { TenantsService } from "@/modules/tenants/tenants.service";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { createTenantResolver } from "@/tenancy/resolver";
import { noTenantCache } from "@/tenancy/tenant-cache";
import { originOf, rpIdOf } from "./rp";
import { createTenantAuth } from "./tenant-auth";
import { SESSION_COOKIE } from "./tenant-janus";

const DOMAIN = "clavix.test";
const RESOURCE = "https://api.clavix.test/mcp";
const REDIRECT = "https://app.example/callback";
const EMAIL = "ada@example.test";
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
const { janusIssuers, authFor, claimsFor, forTenant } = createTenantAuth({
  resolver,
  db: oauthDb,
});

const keys = new Map<string, SigningKeyStore>();
const issuers = createClavixOAuthIssuers({
  resolver,
  db: oauthDb,
  signingKeysFor: (tenantId) => {
    let store = keys.get(tenantId);
    if (store === undefined) {
      store = createMemorySigningKeys();
      keys.set(tenantId, store);
    }
    return store;
  },
  authFor,
  claimsFor,
  resourcesFor: () => ({ [RESOURCE]: { scopes: ["read"] } }),
});

const url = (slug: string, path = "/") => `https://${slug}.${DOMAIN}${path}`;
const tenantOf = async (slug: string): Promise<ResolvedTenant> => {
  const tenant = await resolver.resolveHost(`${slug}.${DOMAIN}`);
  if (tenant === null) throw new Error(`no tenant ${slug}`);
  return tenant;
};
const janusOf = async (slug: string) => {
  const auth = await janusIssuers.forRequest(new Request(url(slug)));
  if (auth === null) throw new Error(`no janus for ${slug}`);
  return auth;
};

// A user of the tenant with a session, and the cookie header that carries it.
async function signedIn(slug: string, email = EMAIL) {
  const auth = await janusOf(slug);
  const user = await auth.create({ email });
  const result = await auth.signInProven(user);
  if (result.status !== "signedIn") throw new Error("no session");
  return {
    user,
    cookie: `${SESSION_COOKIE}=${result.token}`,
    header: auth.cookie.serialize(result.token, result.session),
  };
}
const requestWith = (slug: string, cookie: string, path = "/") =>
  new Request(url(slug, path), { headers: { cookie } });

const sessions: Record<string, Awaited<ReturnType<typeof signedIn>>> = {};

beforeAll(async () => {
  for (const slug of ["acme", "globex"]) {
    await tenants.create({ slug, name: slug });
    await rotateSigningKeys(
      keys.get((await tenantOf(slug)).tenantId) ?? createMemorySigningKeys(),
      {
        now: new Date(),
        lead: "1h",
        retireAfter: "2h",
      },
    );
  }
  sessions["acme"] = await signedIn("acme");
  sessions["globex"] = await signedIn("globex");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await oauthDb.collection("partitionedUsers").deleteMany({});
  await oauthDb.collection("partitionedSessions").deleteMany({});
});

describe("the passkey relying party", () => {
  test("is the tenant's own host, the origin its https origin", async () => {
    const tenant = await tenantOf("acme");
    expect(rpIdOf(tenant)).toBe("acme.clavix.test");
    expect(originOf(tenant)).toBe("https://acme.clavix.test");
  });
});

describe("one user pool per tenant", () => {
  test("the same e-mail is two users, one per tenant", () => {
    const acme = sessions["acme"];
    const globex = sessions["globex"];
    expect(acme?.user.email).toBe(EMAIL);
    expect(globex?.user.email).toBe(EMAIL);
    expect(acme?.user.id).not.toBe(globex?.user.id);
  });

  test("a second user of the same e-mail in one tenant is refused", async () => {
    const auth = await janusOf("acme");
    await expect(auth.create({ email: EMAIL })).rejects.toMatchObject({
      code: "LOGIN_TAKEN",
    });
  });

  test("A's user id is not found from B (findUser and claimsFor)", async () => {
    const aId = sessions["acme"]?.user.id ?? "";
    const acme = await tenantOf("acme");
    const globex = await tenantOf("globex");
    expect(await authFor(globex).findUser(aId)).toBeNull();
    expect(await authFor(acme).findUser(aId)).toMatchObject({ id: aId });
    expect(await claimsFor(globex)({ id: aId }, ["email"])).toEqual({});
    expect(await claimsFor(acme)({ id: aId }, ["email"])).toMatchObject({
      email: EMAIL,
    });
  });
});

describe("sessions", () => {
  test("the cookie is host-only: __Host- prefix, no Domain, Secure, SameSite=Lax", () => {
    const header = sessions["acme"]?.header ?? "";
    expect(header.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).not.toContain("Domain");
  });

  test("the session lives 14 days, sliding", async () => {
    const header = sessions["acme"]?.header ?? "";
    const expires = new Date(/Expires=([^;]+)/.exec(header)?.[1] ?? "");
    const days = (expires.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
  });

  test("a session opened 30 days and 1 minute ago is anonymous even when used a minute ago", async () => {
    const acme = await tenantOf("acme");
    const { user, cookie } = await signedIn("acme", "old@example.test");
    const request = () => requestWith("acme", cookie);
    expect((await authFor(acme).authenticate(request()))?.user.id).toBe(
      user.id,
    );
    // Opened 30 days and 1 minute ago, its sliding expiry still 14 days ahead.
    const opened = new Date(Date.now() - (30 * 86_400_000 + 60_000));
    const ahead = new Date(Date.now() + 14 * 86_400_000);
    const sessions = oauthDb.collection("partitionedSessions");
    const stored = await sessions.find({}).toArray();
    const mine = stored.filter((row) => String(row["userId"]) === user.id);
    expect(mine).toHaveLength(1);
    await sessions.updateOne(
      { _id: mine[0]?.["_id"] as never },
      { $set: { createdAt: opened, expiresAt: ahead } },
    );
    expect(await authFor(acme).authenticate(request())).toBeNull();
  });

  test("authFor answers the user of a session of the tenant", async () => {
    const acme = await tenantOf("acme");
    const cookie = sessions["acme"]?.cookie ?? "";
    const current = await authFor(acme).authenticate(
      requestWith("acme", cookie),
    );
    expect(current?.user.id).toBe(sessions["acme"]?.user.id as string);
  });

  test("authFor is anonymous without a session", async () => {
    const acme = await tenantOf("acme");
    expect(
      await authFor(acme).authenticate(new Request(url("acme"))),
    ).toBeNull();
    expect(await authFor(acme).authenticate(new Headers())).toBeNull();
  });

  test("A's session cookie is anonymous on B", async () => {
    const globex = await tenantOf("globex");
    const cookie = sessions["acme"]?.cookie ?? "";
    expect(
      await authFor(globex).authenticate(requestWith("globex", cookie)),
    ).toBeNull();
    expect(
      await (await janusOf("globex")).authenticate(
        requestWith("globex", cookie),
      ),
    ).toBeNull();
  });
});

describe("the janus of a tenant", () => {
  test("is cached, and rebuilt when the tenant's version moves", async () => {
    const before = await janusOf("acme");
    expect(await janusOf("acme")).toBe(before);
    const acme = await tenantOf("acme");
    await tenants.suspend(acme.tenantId);
    await tenants.reactivate(acme.tenantId);
    const after = await janusOf("acme");
    expect(after).not.toBe(before);
    // The user pool is the partition, not the instance: the session survives.
    const cookie = sessions["acme"]?.cookie ?? "";
    expect(
      await after.authenticate(requestWith("acme", cookie)),
    ).not.toBeNull();
  });

  test("an unknown or suspended host gives no janus", async () => {
    expect(
      await janusIssuers.forRequest(new Request(url("nobody"))),
    ).toBeNull();
    expect(
      await janusIssuers.forRequest(new Request("https://example.org/")),
    ).toBeNull();
    const globex = await tenantOf("globex");
    await tenants.suspend(globex.tenantId);
    expect(
      await janusIssuers.forRequest(new Request(url("globex"))),
    ).toBeNull();
    expect(await forTenant(globex)).toBeNull();
    expect(
      await authFor(globex).findUser(sessions["globex"]?.user.id ?? ""),
    ).toBeNull();
    await tenants.reactivate(globex.tenantId);
    expect(
      await janusIssuers.forRequest(new Request(url("globex"))),
    ).not.toBeNull();
  });
});

describe("OAuth with the real authFor", () => {
  // Starts /authorize on the tenant, then reads the consent step as `cookie`.
  async function consentAs(slug: string, cookie: string | null) {
    const server = await issuers.serverFor(new Request(url(slug)));
    if (server === null) throw new Error("no server");
    const { client } = await server.createClient({
      name: `App of ${slug}`,
      redirectUris: [REDIRECT],
    });
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.id,
      redirect_uri: REDIRECT,
      code_challenge: await s256Challenge("v".repeat(64)),
      code_challenge_method: "S256",
      scope: "read",
      resource: RESOURCE,
      state: "xyz",
    });
    const response = await issuers.handle(
      new Request(url(slug, `/authorize?${query}`)),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "", url(slug));
    expect(location.pathname).toBe("/consent");
    const requestId = location.searchParams.get("request_id") ?? "";
    return server.consent(
      new Request(url(slug, location.pathname), {
        headers: cookie === null ? {} : { cookie },
      }),
      requestId,
    );
  }

  test("/authorize reaches consent, where the session of the tenant is the signed-in user", async () => {
    const consent = await consentAs("acme", sessions["acme"]?.cookie ?? "");
    expect(consent?.signedIn?.user.id).toBe(
      sessions["acme"]?.user.id as string,
    );
  });

  test("A's session, or none, is anonymous at B's consent", async () => {
    for (const cookie of [sessions["acme"]?.cookie ?? "", null]) {
      const consent = await consentAs("globex", cookie);
      expect(consent?.signedIn).toBeNull();
    }
  });
});
