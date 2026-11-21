import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { DataError } from "@softistx/mongo";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { registerClient } from "@/modules/clients/register-client";
import {
  issuerOf,
  PLATFORM_TENANT_SLUG,
  TenantsService,
} from "@/modules/tenants";
import { createClavixOAuthIssuers, userinfoOf } from "@/oauth/issuers";
import { CliInputError } from "@/shared/cli";
import { createTenantResolver } from "@/tenancy/resolver";
import { noTenantCache } from "@/tenancy/tenant-cache";
import { createTenantParOff } from "../../../test/tenant-par-off";
import { parseResourceArgs } from "./resources.cli";
import { mongoDetailTypeClients } from "./resources.client-lists";
import { ResourcesService } from "./resources.service";
import type { RegisterResourceInput } from "./resources.types";

const DOMAIN = "clavix.test";
const REDIRECT = "https://app.example/callback";
const API_A = "https://api.alpha.example/v1";
const API_RACE = "https://api.race.example/v1";
const API_B = "https://api.beta.example/v1";
const config = { scheme: "https", domain: DOMAIN } as const;
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });
const build = (resources = mongo.db.resources) =>
  new ResourcesService({
    resources,
    scopes: mongo.db.scopes,
    detailTypes: mongo.db.detailTypes,
    clients: mongoDetailTypeClients(oauthDb),
    userinfoOf: (slug) => userinfoOf(issuerOf(slug, config)),
    findTenant,
  });
const service = build();

const resolver = createTenantResolver({
  log: () => {},
  lookup: findTenant,
  cache: noTenantCache,
  config,
});
const tenants = new TenantsService(mongo.db.tenants, {
  now: () => new Date(),
  log: () => {},
  domain: DOMAIN,
  onHostsChanged: (hosts) => resolver.invalidate(hosts),
});
const keys = new Map<string, SigningKeyStore>();
const issuers = createClavixOAuthIssuers({
  clock: { now: () => new Date() },
  dpopNonceSecret: "spec-dpop-nonce-secret",
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
  authFor: (tenant) => ({
    authenticate: async () => null,
    findUser: async (userId) =>
      userId === `user-${tenant.slug}` ? { id: userId, active: true } : null,
  }),
  claimsFor: () => async () => ({}),
  resourcesFor: service.storedFor,
});

const scopeNamesOf = async (resourceId: unknown) =>
  (
    await mongo.db.scopes.raw
      .find({ resourceId: resourceId as never })
      .toArray()
  )
    .map((scope) => scope.name)
    .sort();

const url = (slug: string, path: string) => `https://${slug}.${DOMAIN}${path}`;
const VERIFIER = "v".repeat(64);

const authorize = async (
  slug: string,
  clientId: string,
  resource?: string,
  scope = "read",
) =>
  issuers.handle(
    new Request(
      url(
        slug,
        `/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: await s256Challenge(VERIFIER),
          code_challenge_method: "S256",
          scope,
          ...(resource === undefined ? {} : { resource }),
        })}`,
      ),
    ),
  );

// authorize, approve as the tenant's user, exchange the code for tokens.
async function tokenFor(slug: string, clientId: string, resource: string) {
  const response = await authorize(slug, clientId, resource);
  expect(response.status).toBe(302);
  const consent = new URL(
    response.headers.get("location") ?? "",
    url(slug, "/"),
  );
  const server = await issuers.serverFor(new Request(url(slug, "/")));
  if (server === null) throw new Error(`no server for ${slug}`);
  const { redirectTo } = await server.approve(
    { id: `user-${slug}` },
    consent.searchParams.get("request_id") ?? "",
    { scopes: ["read"] },
  );
  const code = new URL(redirectTo).searchParams.get("code") ?? "";
  return issuers.handle(
    new Request(url(slug, "/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        resource,
      }),
    }),
  );
}

const claimsOf = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());

beforeAll(async () => {
  for (const slug of ["resalpha", "resbeta", "respaused"]) {
    await createTenantParOff(tenants, { slug, name: slug });
  }
  for (const slug of ["resalpha", "resbeta"]) {
    const tenant = await resolver.resolveHost(`${slug}.${DOMAIN}`);
    const store = createMemorySigningKeys();
    keys.set(tenant?.tenantId ?? "", store);
    await rotateSigningKeys(store, {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
    await registerClient(
      { now: () => new Date(), db: oauthDb, findTenant },
      { tenant: slug, name: "App", redirectUris: [REDIRECT] },
    );
  }
  const paused = await findTenant("respaused");
  await tenants.suspend(paused?._id.toHexString() ?? "");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.resources.raw.deleteMany({});
});

describe("resources:create", () => {
  test("stores a resource on the tenant, then updates it without duplicating", async () => {
    const first = await service.registerResource({
      tenant: "resalpha",
      uri: API_A,
      scopes: ["read", "write", "read"],
    });
    expect(first).toMatchObject({
      created: true,
      name: "api.alpha.example",
      scopes: ["read", "write"],
    });
    const second = await service.registerResource({
      tenant: "resalpha",
      uri: API_A,
      name: "Alpha API",
      scopes: ["read"],
    });
    expect(second).toMatchObject({ created: false, scopes: ["read"] });
    const alpha = await findTenant("resalpha");
    const stored = await mongo.db.resources.raw
      .find({ tenantId: alpha?._id as never })
      .toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: "Alpha API" });
    // The scopes are `Scope` documents of the resource, replaced by the re-run.
    expect(stored[0]?.["scopes"]).toBeUndefined();
    expect(await scopeNamesOf(stored[0]?._id)).toEqual(["read"]);
  });

  test("refuses bad input, an unknown or suspended tenant and the userinfo URL", async () => {
    const bad = (input: Partial<RegisterResourceInput>) =>
      service.registerResource({
        tenant: "resalpha",
        uri: API_A,
        scopes: ["read"],
        ...input,
      });
    await expect(bad({ uri: "not a uri" })).rejects.toThrow(CliInputError);
    await expect(bad({ uri: "http://api.example/v1" })).rejects.toThrow(
      /https/,
    );
    await expect(bad({ uri: `${API_A}#frag` })).rejects.toThrow(/fragment/);
    await expect(bad({ scopes: [] })).rejects.toThrow(/at least one scope/);
    await expect(bad({ scopes: ['a"b'] })).rejects.toThrow(/printable/);
    await expect(bad({ tenant: "nobody" })).rejects.toThrow(/no tenant/);
    await expect(bad({ tenant: "respaused" })).rejects.toThrow(/suspended/);
    await expect(
      bad({ uri: userinfoOf(issuerOf("resalpha", config)) }),
    ).rejects.toThrow(/userinfo/);
    // The same URL spelled another way is still the userinfo endpoint.
    const spelled = userinfoOf(issuerOf("resalpha", config)).replace(
      "https://",
      "HTTPS://",
    );
    await expect(bad({ uri: spelled })).rejects.toThrow(/userinfo/);
    // Another spelling of a resource would be a second audience: refused with
    // the canonical form (a bare origin gains "/", so it is not rewritten).
    await expect(bad({ uri: "https://API.alpha.example/v1" })).rejects.toThrow(
      /write it as https:\/\/api\.alpha\.example\/v1/,
    );
    await expect(bad({ uri: "https://api.alpha.example" })).rejects.toThrow(
      /write it as https:\/\/api\.alpha\.example\//,
    );
  });

  test("a concurrent run that created the resource first is re-read and updated", async () => {
    await service.registerResource({
      tenant: "resalpha",
      uri: API_RACE,
      scopes: ["read"],
    });
    // The first read misses (as if the other run had not written yet), the
    // create is then refused by the unique index.
    let reads = 0;
    const stale = new Proxy(mongo.db.resources, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== "findFirst") return value;
        return async (...args: unknown[]) => {
          reads += 1;
          return reads === 1
            ? undefined
            : (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const result = await build(stale).registerResource({
      tenant: "resalpha",
      uri: API_RACE,
      scopes: ["write"],
    });
    expect(result).toMatchObject({ created: false, scopes: ["write"] });
    const alpha = await findTenant("resalpha");
    const stored = await mongo.db.resources.raw
      .find({ tenantId: alpha?._id as never, uri: API_RACE })
      .toArray();
    expect(stored).toHaveLength(1);
    expect(await scopeNamesOf(stored[0]?._id)).toEqual(["write"]);
  });

  test("a store failure is not an input error: it reaches the script as it is", async () => {
    const failing = new Proxy(mongo.db.resources, {
      get(target, key, receiver) {
        if (key === "create") {
          return async () => {
            throw new DataError("store down", { serverCode: 6 });
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const attempt = build(failing).registerResource({
      tenant: "resalpha",
      uri: API_B,
      scopes: ["read"],
    });
    await expect(attempt).rejects.toBeInstanceOf(DataError);
    await expect(attempt).rejects.not.toBeInstanceOf(CliInputError);
  });

  test("parses the script's flags", () => {
    expect(
      parseResourceArgs([
        "--tenant",
        "acme",
        "--uri",
        API_A,
        "--scope",
        "read",
        "--scope",
        "write",
      ]),
    ).toEqual({ tenant: "acme", uri: API_A, scopes: ["read", "write"] });
    expect(() => parseResourceArgs(["--uri", API_A])).toThrow(/--tenant/);
    expect(() => parseResourceArgs(["--tenant", "a"])).toThrow(/--uri/);
    expect(() => parseResourceArgs(["--bogus"])).toThrow(CliInputError);
  });
});

describe("a registered resource in the issuer", () => {
  test("an access token for it carries the resource as aud and is signed by the tenant's key", async () => {
    const clientId = "app";
    const response = await tokenFor("resalpha", clientId, API_A);
    expect(response.status).toBe(200);
    const { access_token } = (await response.json()) as {
      access_token: string;
    };
    const claims = claimsOf(access_token);
    expect(claims.aud).toBe(API_A);
    expect(claims.iss).toBe(url("resalpha", ""));
    // Verified against the tenant's own JWKS.
    const jwks = (await (
      await issuers.handle(new Request(url("resalpha", "/jwks.json")))
    )?.json()) as { keys: { kid: string }[] };
    const header = JSON.parse(
      Buffer.from(access_token.split(".")[0] ?? "", "base64url").toString(),
    );
    expect(jwks.keys.map((key) => key.kid)).toContain(header.kid);
  });

  test("a resource registered after the issuer was built serves at once", async () => {
    const before = await authorize(
      "resalpha",
      "app",
      "https://late.example/v1",
    );
    expect(before.status).toBe(302);
    expect(before.headers.get("location")).not.toContain("/consent");
    await service.registerResource({
      tenant: "resalpha",
      uri: "https://late.example/v1",
      scopes: ["read"],
    });
    const after = await authorize("resalpha", "app", "https://late.example/v1");
    expect(
      new URL(after.headers.get("location") ?? "", url("resalpha", "/"))
        .pathname,
    ).toBe("/consent");
  });

  test("an unknown resource is refused (invalid_target), and a client without one gets userinfo's", async () => {
    const unknown = await authorize("resalpha", "app", "https://nope.example");
    const location = unknown.headers.get("location") ?? "";
    expect(location).not.toContain("/consent");
    expect(location).toContain("invalid_target");
    const none = await authorize("resalpha", "app", undefined, "openid");
    expect(
      new URL(none.headers.get("location") ?? "", url("resalpha", "/"))
        .pathname,
    ).toBe("/consent");
  });

  test("tenant isolation: A's resource never serves B, and B gets no token with A's audience", async () => {
    await service.registerResource({
      tenant: "resbeta",
      uri: API_B,
      scopes: ["read"],
    });
    const alpha = await findTenant("resalpha");
    const beta = await findTenant("resbeta");
    const forAlpha = await service.storedFor(
      (await resolver.resolveHost(`resalpha.${DOMAIN}`)) as never,
    );
    const forBeta = await service.storedFor(
      (await resolver.resolveHost(`resbeta.${DOMAIN}`)) as never,
    );
    expect(alpha?._id.equals(beta?._id as never)).toBe(false);
    expect(Object.keys(forAlpha)).not.toContain(API_B);
    expect(Object.keys(forBeta)).toEqual([API_B]);

    const crossed = await authorize("resbeta", "app", API_A);
    expect(crossed.headers.get("location")).toContain("invalid_target");
    const own = await tokenFor("resbeta", "app", API_B);
    expect(
      claimsOf(((await own.json()) as { access_token: string }).access_token)
        .aud,
    ).toBe(API_B);
    const reverse = await authorize("resalpha", "app", API_B);
    expect(reverse.headers.get("location")).toContain("invalid_target");
  });

  test("changing a resource's scopes or removing it rebuilds the issuer", async () => {
    const uri = "https://churn.example/v1";
    const register = (scopes: string[]) =>
      service.registerResource({ tenant: "resalpha", uri, scopes });
    const consents = async () => {
      const response = await authorize("resalpha", "app", uri);
      return (response.headers.get("location") ?? "").includes("/consent");
    };
    await register(["write"]);
    expect(await consents()).toBe(false); // scope "read" is not offered yet
    await register(["read"]);
    expect(await consents()).toBe(true);
    const alpha = await findTenant("resalpha");
    await mongo.db.resources.raw.deleteOne({
      tenantId: alpha?._id as never,
      uri,
    });
    expect(await consents()).toBe(false);
  });
});
