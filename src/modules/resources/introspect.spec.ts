import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { registerClient } from "@/clients/register-client";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { TenantsService } from "@/modules/tenants/tenants.service";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { createTenantResolver } from "@/tenancy/resolver";
import { noTenantCache } from "@/tenancy/tenant-cache";
import { createTenantParOff } from "../../../test/tenant-par-off";
import { registerResource, storedResourcesFor } from "./register-resource";

// /introspect answers for tokens whose `aud` is a resource registered through
// resources:create (the `endpoints.introspection.authorize` hook), and only
// within the tenant that issued them.
const DOMAIN = "clavix.test";
const REDIRECT = "https://app.example/callback";
const VERIFIER = "v".repeat(64);
const API_A = "https://api.intro-alpha.example/v1";
const API_B = "https://api.intro-beta.example/v1";
const config = { scheme: "https", domain: DOMAIN } as const;
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });
const options = {
  collection: mongo.db.resources,
  scopes: mongo.db.scopes,
  findTenant,
  issuerOf: (slug: string) => issuerOf(slug, config),
};

const resolver = createTenantResolver({
  lookup: findTenant,
  cache: noTenantCache,
  config,
});
const tenants = new TenantsService(mongo.db.tenants, {
  domain: DOMAIN,
  onHostsChanged: (hosts) => resolver.invalidate(hosts),
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
  authFor: (tenant) => ({
    authenticate: async () => null,
    findUser: async (userId) =>
      userId === `user-${tenant.slug}` ? { id: userId, active: true } : null,
  }),
  claimsFor: () => async () => ({}),
  resourcesFor: storedResourcesFor(mongo.db.resources, mongo.db.scopes),
});

const url = (slug: string, path: string) => `https://${slug}.${DOMAIN}${path}`;
const basic = (id: string, secret: string) =>
  `Basic ${btoa(`${id}:${secret}`)}`;
const secrets: Record<string, string> = {};
const CLIENT = "backend";

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

// authorize, approve as the tenant's user, exchange the code for a token whose
// `aud` is the resource.
async function accessTokenFor(slug: string, resource: string) {
  const authorize = await issuers.handle(
    new Request(
      url(
        slug,
        `/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: CLIENT,
          redirect_uri: REDIRECT,
          code_challenge: await s256Challenge(VERIFIER),
          code_challenge_method: "S256",
          scope: "read",
          resource,
        })}`,
      ),
    ),
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
    { scopes: ["read"] },
  );
  const response = await post(
    slug,
    "/token",
    {
      grant_type: "authorization_code",
      code: new URL(redirectTo).searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource,
    },
    basic(CLIENT, secrets[slug] ?? ""),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

const introspect = (slug: string, token: string, as = slug) =>
  post(slug, "/introspect", { token }, basic(CLIENT, secrets[as] ?? ""));

beforeAll(async () => {
  for (const slug of ["introalpha", "introbeta"]) {
    await createTenantParOff(tenants, { slug, name: slug });
    const tenant = await resolver.resolveHost(`${slug}.${DOMAIN}`);
    const store = createMemorySigningKeys();
    keys.set(tenant?.tenantId ?? "", store);
    await rotateSigningKeys(store, {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
    const client = await registerClient(
      { db: oauthDb, findTenant },
      {
        tenant: slug,
        name: "Back end",
        clientId: CLIENT,
        redirectUris: [REDIRECT],
        type: "confidential",
      },
    );
    secrets[slug] = client.clientSecret ?? "";
  }
  await registerResource(options, {
    tenant: "introalpha",
    uri: API_A,
    scopes: ["read"],
  });
  await registerResource(options, {
    tenant: "introbeta",
    uri: API_B,
    scopes: ["read"],
  });
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.resources.raw.deleteMany({});
});

describe("/introspect with registered resources", () => {
  test("a token whose aud is a registered resource is active", async () => {
    const token = await accessTokenFor("introalpha", API_A);
    const response = await introspect("introalpha", token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      active: true,
      scope: "read",
      sub: "user-introalpha",
      aud: API_A,
      iss: url("introalpha", ""),
    });
  });

  test("a resource registered after the issuer was built is introspectable at once", async () => {
    const late = "https://late.intro-alpha.example/v1";
    await registerResource(options, {
      tenant: "introalpha",
      uri: late,
      scopes: ["read"],
    });
    const token = await accessTokenFor("introalpha", late);
    const response = await introspect("introalpha", token);
    expect(await response.json()).toMatchObject({ active: true, aud: late });
  });

  test("a resource removed after the token was issued makes it inactive", async () => {
    const gone = "https://gone.intro-alpha.example/v1";
    await registerResource(options, {
      tenant: "introalpha",
      uri: gone,
      scopes: ["read"],
    });
    const token = await accessTokenFor("introalpha", gone);
    const alpha = await findTenant("introalpha");
    await mongo.db.resources.raw.deleteOne({
      tenantId: alpha?._id as never,
      uri: gone,
    });
    const response = await introspect("introalpha", token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: false });
  });

  test("cross-tenant: B's own client sees A's token as inactive, and A's credentials are refused at B", async () => {
    const token = await accessTokenFor("introalpha", API_A);
    // B's valid client, B's resources only: A's audience is unknown there.
    const own = await introspect("introbeta", token);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ active: false });
    // A's secret does not authenticate in B's partition.
    const crossed = await introspect("introbeta", token, "introalpha");
    expect(crossed.status).toBe(401);
    // And the reverse: A's client does not see B's token.
    const betaToken = await accessTokenFor("introbeta", API_B);
    expect(await (await introspect("introalpha", betaToken)).json()).toEqual({
      active: false,
    });
    expect(
      await (await introspect("introbeta", betaToken)).json(),
    ).toMatchObject({ active: true, aud: API_B });
  });
});
