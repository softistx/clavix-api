import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { decodeJwt } from "jose";
import { createApp } from "@/app";
import { agentClientsService } from "@/config/agent-clients";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { resourcesService } from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { authFor, claimsFor, janusIssuers } from "@/config/users";
import { registerClient } from "@/modules/clients/register-client";
import {
  issuerOf,
  PLATFORM_TENANT_SLUG,
  TenantsService,
} from "@/modules/tenants";
import { SESSION_COOKIE } from "@/modules/users";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { clientHeaders } from "~/client-header";
import { createTenantParOff } from "../../../test/tenant-par-off";

const RESOURCE = "https://api.clavix.test/mcp";
const REDIRECT = "https://app.example/callback";
const VERIFIER = "v".repeat(64);
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const tenants = new TenantsService(mongo.db.tenants, {
  now: () => new Date(),
  log: () => {},
  onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
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
  clock: { now: () => new Date() },
  dpopNonceSecret: "spec-dpop-nonce-secret",
  resolver: tenantResolver,
  db: oauthDb,
  signingKeysFor,
  authFor,
  claimsFor,
  resourcesFor: () => ({ [RESOURCE]: { scopes: ["read"] } }),
});
const app = createApp({ oauth: issuers });

const url = (slug: string, path = "/") => `${issuerOf(slug, origin)}${path}`;
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
  language?: string,
): Promise<GqlResult> => {
  const response = await app.request(url(slug, "/graphql"), {
    method: "POST",
    headers: {
      ...clientHeaders,
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
      ...(language === undefined ? {} : { "accept-language": language }),
    },
    body: JSON.stringify({ query, variables }),
  });
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
  for (const slug of ["acme", "globex", "initech"]) {
    await createTenantParOff(tenants, { slug, name: slug });
    const tenant = await tenantResolver.resolveHost(new URL(url(slug)).host);
    if (tenant === null) throw new Error("tenant not resolved");
    await rotateSigningKeys(signingKeysFor(tenant.tenantId), {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
    const registered = await registerClient(
      {
        now: () => new Date(),
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

  test("a scope's label is the tenant's description, in the viewer's language", async () => {
    const acme = await mongo.db.tenants.findFirst({ slug: "acme" });
    if (acme === undefined) throw new Error("no tenant");
    await resourcesService.createScope(acme._id, {
      name: "email",
      description: { fr: "Votre adresse e-mail", en: "Your email address" },
      resourceId: null,
      claims: [],
    });
    const labelsOf = async (slug: string, language?: string) => {
      const id = await authorize(slug);
      const result = await gql(slug, REQUEST, { id }, cookieOf(slug), language);
      expect(result.errors).toBeUndefined();
      const { scopes } = (result.data?.["oauthRequest"] ?? { scopes: [] }) as {
        scopes: { name: string; label: string }[];
      };
      return Object.fromEntries(scopes.map((s) => [s.name, s.label]));
    };
    expect((await labelsOf("acme", "fr-CA,en;q=0.8"))["email"]).toBe(
      "Votre adresse e-mail",
    );
    const english = await labelsOf("acme", "en-US");
    expect(english["email"]).toBe("Your email address");
    // A scope the tenant did not describe keeps janus's label.
    expect(english["openid"]).not.toBe("");
    expect((await labelsOf("acme"))["email"]).toBe("Your email address");
    // Another tenant never reads acme's texts.
    const other = await labelsOf("globex", "fr");
    expect(other["email"]).not.toBe("Votre adresse e-mail");
  });

  test("a client is marked an agent only for its own tenant's agents", async () => {
    const query = `query($id: ID!) { oauthRequest(id: $id) { client { id agent registeredAt } } }`;
    const markOf = async (slug: string) => {
      const id = await authorize(slug);
      const result = await gql(slug, query, { id }, cookieOf(slug));
      expect(result.errors).toBeUndefined();
      const request = result.data?.["oauthRequest"] as
        | { client: unknown }
        | undefined;
      return request?.client;
    };
    // A console-registered client is no agent.
    expect(await markOf("acme")).toEqual({
      id: "backend",
      agent: false,
      registeredAt: null,
    });
    const acme = await mongo.db.tenants.findFirst({ slug: "acme" });
    if (acme === undefined) throw new Error("no tenant");
    try {
      await agentClientsService.record(acme._id.toHexString(), {
        clientId: "backend",
        kind: "dynamic",
      });
      const marked = (await markOf("acme")) as {
        agent: boolean;
        registeredAt: string;
      };
      expect(marked.agent).toBe(true);
      expect(new Date(marked.registeredAt).getTime()).toBeGreaterThan(0);
      // The same client id in another tenant is not acme's agent.
      expect(await markOf("globex")).toMatchObject({ agent: false });
      // connectedApps carries the marker too.
      const id = await authorize("acme");
      const approved = await gql("acme", APPROVE, { id }, cookieOf("acme"));
      expect(approved.errors).toBeUndefined();
      const apps = await gql(
        "acme",
        "{ connectedApps { client { id agent } } }",
        {},
        cookieOf("acme"),
      );
      expect(apps.errors).toBeUndefined();
      expect(apps.data?.["connectedApps"]).toContainEqual({
        client: { id: "backend", agent: true },
      });
    } finally {
      await mongo.db.agentClients.raw.deleteMany({});
    }
  });

  test("an anonymous viewer is UNAUTHENTICATED", async () => {
    const id = await authorize("acme");
    const result = await gql("acme", REQUEST, { id });
    expect(codeOf(result)).toBe("UNAUTHENTICATED");
  });
});

describe("approve", () => {
  test("ends with an id_token whose auth_time is the session's sign-in time and a first-factor acr", async () => {
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
    // The session proved one factor: the approval states it (D9).
    expect(claims["acr"]).toBe("urn:clavix:acr:1fa");
  });

  test("a session older than five minutes is STEP_UP_REQUIRED and the request stays pending", async () => {
    const auth = await janusIssuers.forRequest(new Request(url("acme")));
    const user = await auth?.create({ email: "old@example.test" });
    if (auth === null || user === undefined) throw new Error("no janus");
    const result = await auth.signInProven(user);
    if (result.status !== "signedIn") throw new Error("no session");
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
    const decision = denied.data?.["denyOAuthRequest"] as {
      redirectTo: string;
      grantId: string | null;
    };
    const { redirectTo, grantId } = decision;
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

describe("a foreign page cannot decide", () => {
  const post = (headers: Record<string, string>, body: string) =>
    app.request(url("acme", "/graphql"), {
      method: "POST",
      headers: { cookie: cookieOf("acme"), ...headers },
      body,
    });

  test("a foreign Origin sees no request and decides nothing", async () => {
    const id = await authorize("acme");
    const response = await post(
      {
        ...clientHeaders,
        "content-type": "application/json",
        origin: "https://evil.clavix.test",
      },
      JSON.stringify({ query: DENY, variables: { id } }),
    );
    const body = (await response.json()) as GqlResult;
    expect(codeOf(body)).toBe("NOT_FOUND");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const still = await gql("acme", REQUEST, { id }, cookieOf("acme"));
    expect(still.errors).toBeUndefined();
  });

  test("an Origin of null sees no request", async () => {
    const id = await authorize("acme");
    const response = await post(
      { "content-type": "application/json", origin: "null" },
      JSON.stringify({ query: REQUEST, variables: { id } }),
    );
    expect(codeOf((await response.json()) as GqlResult)).toBe("NOT_FOUND");
  });

  test("a form post decides nothing", async () => {
    const id = await authorize("acme");
    const response = await post(
      { "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams({
        query: `mutation { denyOAuthRequest(id: "${id}") { redirectTo } }`,
      }).toString(),
    );
    const body = (await response.json()) as GqlResult;
    expect(body.data?.["denyOAuthRequest"] ?? null).toBeNull();
    const still = await gql("acme", REQUEST, { id }, cookieOf("acme"));
    expect(still.errors).toBeUndefined();
  });

  test("a foreign Origin or a form post cannot list or revoke connected apps", async () => {
    const foreign = await post(
      {
        ...clientHeaders,
        "content-type": "application/json",
        origin: "https://evil.clavix.test",
      },
      JSON.stringify({ query: 'mutation { revokeConnectedApp(id: "x") }' }),
    );
    expect(codeOf((await foreign.json()) as GqlResult)).toBe("NOT_FOUND");
    const form = await post(
      { "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams({ query: "{ connectedApps { id } }" }).toString(),
    );
    const body = (await form.json()) as GqlResult;
    expect(body.data?.["connectedApps"] ?? null).toBeNull();
  });

  test("the page's own Origin passes", async () => {
    const id = await authorize("acme");
    const response = await post(
      { "content-type": "application/json", origin: issuerOf("acme", origin) },
      JSON.stringify({ query: REQUEST, variables: { id } }),
    );
    const body = (await response.json()) as GqlResult;
    expect(body.errors).toBeUndefined();
  });
});

// "initech" is this block's own tenant with its own signed-in session, so the
// refusal does not depend on what the specs before it did to acme's session.
const expectRefused = (result: GqlResult, code: string) => {
  expect(result.data?.["approveOAuthRequest"] ?? null).toBeNull();
  expect(result.data?.["denyOAuthRequest"] ?? null).toBeNull();
  expect(codeOf(result)).toBe(code);
};

describe("a tenant that is not live", () => {
  test("a suspended tenant is TENANT_SUSPENDED on approve and deny, and a resumed one mints a code again", async () => {
    const initech = await mongo.db.tenants.findFirst({ slug: "initech" });
    if (initech === undefined) throw new Error("no initech");
    const id = await authorize("initech");
    await tenants.suspend(initech._id);
    try {
      for (const query of [APPROVE, DENY]) {
        const result = await gql("initech", query, { id }, cookieOf("initech"));
        expectRefused(result, "TENANT_SUSPENDED");
      }
    } finally {
      await tenants.reactivate(initech._id);
    }
    const resumed = await gql("initech", APPROVE, { id }, cookieOf("initech"));
    expect(resumed.errors).toBeUndefined();
    const approved = resumed.data?.["approveOAuthRequest"] as
      | { redirectTo: string }
      | undefined;
    const redirectTo = approved?.redirectTo ?? "";
    expect(redirectTo).toContain("code=");
    const token = await exchange("initech", redirectTo);
    expect(token.status).toBe(200);
  });

  test("a deleted tenant is TENANT_SUSPENDED too, and a restored one mints a code again", async () => {
    const initech = await mongo.db.tenants.findFirst({ slug: "initech" });
    if (initech === undefined) throw new Error("no initech");
    const id = await authorize("initech");
    await tenants.delete(initech._id);
    try {
      const result = await gql("initech", APPROVE, { id }, cookieOf("initech"));
      expectRefused(result, "TENANT_SUSPENDED");
    } finally {
      await tenantsService.restore(initech._id.toHexString());
      await tenants.reactivate(initech._id);
    }
    const restored = await gql("initech", APPROVE, { id }, cookieOf("initech"));
    expect(restored.errors).toBeUndefined();
  });
});
