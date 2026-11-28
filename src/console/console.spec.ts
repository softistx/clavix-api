import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fixedClock } from "@softistx/janus";
import {
  createMemorySigningKeys,
  type OAuthUserPrincipal,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { getCollection } from "@softistx/mongo";
import { generateKeyPair, SignJWT } from "jose";
import { ObjectId } from "mongodb";
import { access } from "@/config/access";
import { createConsoleDeps } from "@/config/console";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { noDetailTypes, noUserLock } from "@/config/no-ops";
import { oauthDb } from "@/config/oauth-db";
import { resourcesFor } from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { authFor, claimsFor, janusIssuers } from "@/config/users";
import type { AdminEventInput } from "@/console/admin-events/recorder";
import { registerClient } from "@/modules/clients";
import {
  detailTypes,
  mongoDetailTypeClients,
  ResourcesService,
  resources,
  scopes,
} from "@/modules/resources";
import {
  issuerOf,
  PLATFORM_TENANT_SLUG,
  partitionOf,
  tenants,
} from "@/modules/tenants";
import { userinfoOf } from "@/oauth/building";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { createTestApp } from "~/app";
import { clientHeaders } from "~/client-header";
import { createDpopKey, type DpopKey, withNonce } from "~/dpop";
import { type GqlResult, gqlOf } from "~/gql";
import { consoleLimixWith } from "~/guard-rules";
import { errorBody, tokenBody } from "~/json";
import { defined } from "~/narrow";
import { serverAuthenticating } from "~/oauth-server-double";
import { quietOAuth } from "~/ports";
import { createConsoleAuthenticator } from "./auth";
import { onPlatform, onTenant } from "./guard";
import {
  CONSOLE_CLIENT_ID,
  CONSOLE_EXPORT_PATH,
  CONSOLE_PATH,
  consoleAudience,
  consoleOrigin,
  consoleRedirectUri,
} from "./identity";
import { createConsoleSchema } from "./schema";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const AUDIENCE = consoleAudience(origin);
const PUBLIC_URL = `${consoleOrigin(origin)}${CONSOLE_PATH}`;
const OTHER = "https://other.test/api";
// The console client is the migration's: its seed resets it to this URI.
const REDIRECT = consoleRedirectUri(origin);
const VERIFIER = "v".repeat(64);
const CLIENT = { id: CONSOLE_CLIENT_ID, secret: "" };
const FOREIGN = { id: "spec-foreign", secret: "" };

const clock = fixedClock(new Date());
const keys = new Map<string, SigningKeyStore>();
const issuers = createClavixOAuthIssuers({
  ...quietOAuth,
  dpopNonceSecret: "spec-dpop-nonce-secret",
  resolver: tenantResolver,
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
  resourcesFor,
  clock,
});
const serverOfClavix = async () =>
  issuers.serverFor(new Request(issuerOf(PLATFORM_TENANT_SLUG, origin)));
const deps = createConsoleDeps(issuers);
const app = createTestApp({
  oauth: issuers,
  console: {
    ...deps,
    authenticate: createConsoleAuthenticator({
      audience: AUDIENCE,
      publicUrl: PUBLIC_URL,
      serverOfClavix,
    }),
  },
});

const findTenant = (slug: string) =>
  getCollection(oauthDb, tenants).findFirst({ slug });

const call = (query: string, token?: string) =>
  app.request(`http://localhost${CONSOLE_PATH}`, {
    method: "POST",
    headers: {
      ...clientHeaders,
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ query }),
  });
const gql = async (query: string, token?: string) =>
  gqlOf(await call(query, token));

/** Proves the e-mail of a `clavix` user, as a confirmed link does. */
async function verify(userId: string, verified = true) {
  const janus = await janusIssuers.forRequest(
    new Request(issuerOf(PLATFORM_TENANT_SLUG, origin)),
  );
  const user = await janus?.findUser(userId);
  if (
    janus === undefined ||
    janus === null ||
    user === null ||
    user === undefined
  )
    throw new Error("no clavix user to verify");
  await janus.setEmailVerified(user, verified);
}

const ME = "{ me { user { id email } platformRole memberships { role } } }";

// A real token: authorize on the clavix issuer, approve as `userId`, exchange.
async function tokenFor(
  userId: string,
  resource: string,
  scope: string,
  client: { id: string; secret: string } = CLIENT,
  dpop?: DpopKey,
): Promise<string> {
  const server = await serverOfClavix();
  if (server === null) throw new Error("no clavix server");
  const issuer = issuerOf(PLATFORM_TENANT_SLUG, origin);
  const authorize = await issuers.handle(
    new Request(
      `${issuer}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.id,
        redirect_uri: REDIRECT,
        code_challenge: await s256Challenge(VERIFIER),
        code_challenge_method: "S256",
        scope,
        resource,
        state: "xyz",
      })}`,
    ),
  );
  expect(authorize.status).toBe(302);
  const requestId =
    new URL(authorize.headers.get("location") ?? "", issuer).searchParams.get(
      "request_id",
    ) ?? "";
  const { redirectTo } = await server.approve({ id: userId }, requestId, {
    scopes: scope.split(" "),
  });
  const tokenUrl = `${issuer}/token`;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: new URL(redirectTo).searchParams.get("code") ?? "",
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource,
  });
  // A DPoP token needs the server's nonce: the first proof is refused with it.
  const exchanged = await withNonce(async (nonce) =>
    issuers.handle(
      new Request(tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa(`${client.id}:${client.secret}`)}`,
          ...(dpop === undefined
            ? {}
            : {
                dpop: await dpop.proof("POST", tokenUrl, {
                  ...(nonce === undefined ? {} : { nonce }),
                }),
              }),
        },
        body: form,
      }),
    ),
  );
  return tokenBody.parse(await exchanged.json()).access_token;
}

let ada = "";
let bob = "";
let tenantA = "";
let tenantB = "";

beforeAll(async () => {
  // Other specs clear shared collections: seed what the migration seeds.
  await (await import("@/migrations/console-seed")).seedConsole(
    oauthDb,
    origin,
  );
  const clavix = await findTenant(PLATFORM_TENANT_SLUG);
  if (clavix === undefined) throw new Error("no clavix tenant");
  await rotateSigningKeys(
    keys.get(partitionOf(clavix._id)) ??
      (() => {
        const store = createMemorySigningKeys();
        keys.set(partitionOf(clavix._id), store);
        return store;
      })(),
    { now: clock.now(), lead: "1h", retireAfter: "2h" },
  );
  const registered = await registerClient(
    {
      now: () => new Date(),
      db: oauthDb,
      findTenant,
      detailTypes: noDetailTypes,
    },
    {
      tenant: PLATFORM_TENANT_SLUG,
      name: "Spec console",
      clientId: CLIENT.id,
      redirectUris: [REDIRECT],
      type: "confidential",
      // The migration's `console` client may already be there: a fresh secret.
      rotateSecret: true,
    },
  );
  CLIENT.secret = registered.clientSecret ?? "";
  FOREIGN.secret =
    (
      await registerClient(
        {
          detailTypes: noDetailTypes,
          now: () => new Date(),
          db: oauthDb,
          findTenant,
        },
        {
          tenant: PLATFORM_TENANT_SLUG,
          name: "Spec foreign",
          clientId: FOREIGN.id,
          redirectUris: [REDIRECT],
          type: "confidential",
        },
      )
    ).clientSecret ?? "";
  await new ResourcesService({
    resources: getCollection(oauthDb, resources),
    scopes: getCollection(oauthDb, scopes),
    detailTypes: getCollection(oauthDb, detailTypes),
    clients: mongoDetailTypeClients(oauthDb),
    userinfoOf: (slug) => userinfoOf(issuerOf(slug, origin)),
    findTenant,
    scopesDropped: async () => {},
  }).registerResource({
    tenant: PLATFORM_TENANT_SLUG,
    uri: OTHER,
    name: "Other",
    scopes: ["read"],
  });
  const janus = await janusIssuers.forRequest(
    new Request(issuerOf(PLATFORM_TENANT_SLUG, origin)),
  );
  if (janus === null) throw new Error("no janus for clavix");
  // The console needs a proved e-mail (ADR-0041): these callers have one.
  const verified = async (input: { email: string; name?: string }) =>
    (await janus.setEmailVerified(await janus.create(input), true)).id;
  ada = await verified({ email: "ada@console.test", name: "Ada" });
  bob = await verified({ email: "bob@console.test", name: "Bob" });
  tenantA = (await tenantsService.create({ slug: "con-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "con-b", name: "B" })).id;
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $nin: [PLATFORM_TENANT_SLUG] },
  });
  await oauthDb.collection("partitionedUsers").deleteMany({});
  await oauthDb.collection("partitionedSessions").deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

describe("the clavix tenant requires DPoP", () => {
  const setRequired = async (required: boolean) => {
    await oauthDb.collection("tenants").updateOne(
      { slug: PLATFORM_TENANT_SLUG },
      {
        $set: { "oauth.dpop.required": required },
        $inc: { version: 1 },
      },
    );
  };
  const callAs = (scheme: string, token: string, proof?: string) =>
    app.request(`http://localhost${CONSOLE_PATH}`, {
      method: "POST",
      headers: {
        ...clientHeaders,
        "content-type": "application/json",
        authorization: `${scheme} ${token}`,
        ...(proof === undefined ? {} : { dpop: proof }),
      },
      body: JSON.stringify({ query: ME }),
    });

  test("a token request with no proof is refused; a proved token reaches `me` and the same token as Bearer is refused", async () => {
    await setRequired(true);
    try {
      await expect(
        tokenFor(ada, AUDIENCE, "console openid email"),
      ).rejects.toThrow();
      const key = await createDpopKey();
      const token = await tokenFor(
        ada,
        AUDIENCE,
        "console openid email",
        CLIENT,
        key,
      );
      expect((await callAs("Bearer", token)).status).toBe(401);
      const asked = await callAs(
        "DPoP",
        token,
        await key.proof("POST", PUBLIC_URL, { accessToken: token }),
      );
      const nonce = asked.headers.get("dpop-nonce") ?? "";
      const response = await callAs(
        "DPoP",
        token,
        await key.proof("POST", PUBLIC_URL, { accessToken: token, nonce }),
      );
      expect(response.status).toBe(200);
      const result = await gqlOf(response);
      expect(result.data?.["me"]).toMatchObject({ user: { id: ada } });
    } finally {
      await setRequired(false);
    }
  });
});

describe("the console's DPoP token", () => {
  const callDpop = (token: string, scheme: string, proof?: string) =>
    app.request(`http://localhost${CONSOLE_PATH}`, {
      method: "POST",
      headers: {
        ...clientHeaders,
        "content-type": "application/json",
        authorization: `${scheme} ${token}`,
        ...(proof === undefined ? {} : { dpop: proof }),
      },
      body: JSON.stringify({ query: ME }),
    });
  // The proof names the console's public URL, not the forwarded `http://localhost`.
  const signed = (key: DpopKey, token: string, nonce?: string) =>
    key.proof("POST", PUBLIC_URL, {
      accessToken: token,
      ...(nonce === undefined ? {} : { nonce }),
    });

  test("a DPoP token with its proof reaches `me`, after one nonce retry", async () => {
    const key = await createDpopKey();
    const token = await tokenFor(
      ada,
      AUDIENCE,
      "console openid email",
      CLIENT,
      key,
    );
    const asked = await callDpop(token, "DPoP", await signed(key, token));
    expect(asked.status).toBe(401);
    expect(asked.headers.get("www-authenticate")).toContain(
      'DPoP realm="clavix-console", error="use_dpop_nonce"',
    );
    const nonce = asked.headers.get("dpop-nonce") ?? "";
    expect(nonce).not.toBe("");
    const response = await callDpop(
      token,
      "DPoP",
      await signed(key, token, nonce),
    );
    expect(response.status).toBe(200);
    const result = await gqlOf(response);
    expect(result.errors).toBeUndefined();
    expect(result.data?.["me"]).toMatchObject({ user: { id: ada } });
  });

  test("the audit export checks the proof against its own path, not the GraphQL one", async () => {
    const key = await createDpopKey();
    const token = await tokenFor(
      ada,
      AUDIENCE,
      "console openid email",
      CLIENT,
      key,
    );
    const exportUrl = `${consoleOrigin(origin)}${CONSOLE_EXPORT_PATH}`;
    const call = (proof: string) =>
      app.request(
        `http://localhost${CONSOLE_EXPORT_PATH}?tenantId=${new ObjectId().toHexString()}&log=admin`,
        { headers: { authorization: `DPoP ${token}`, dpop: proof } },
      );
    // The first proof has no nonce: the server asks for one, naming the export's own htu.
    const asked = await call(
      await key.proof("GET", exportUrl, { accessToken: token }),
    );
    expect(asked.status).toBe(401);
    const nonce = asked.headers.get("dpop-nonce") ?? "";
    expect(nonce).not.toBe("");
    // A proof for the GraphQL URL is refused, the export's own passes authentication
    // (the caller then has no role on that tenant: 403, not 401).
    const wrong = await call(
      await key.proof("GET", PUBLIC_URL, { accessToken: token, nonce }),
    );
    expect(wrong.status).toBe(401);
    const right = await call(
      await key.proof("GET", exportUrl, { accessToken: token, nonce }),
    );
    expect(right.status).toBe(403);
  });

  test("a bound token sent as Bearer is refused", async () => {
    const key = await createDpopKey();
    const token = await tokenFor(
      ada,
      AUDIENCE,
      "console openid email",
      CLIENT,
      key,
    );
    const response = await callDpop(token, "Bearer");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("DPoP");
  });

  test("a DPoP token with no proof, or another key's, is refused", async () => {
    const key = await createDpopKey();
    const token = await tokenFor(
      ada,
      AUDIENCE,
      "console openid email",
      CLIENT,
      key,
    );
    const none = await callDpop(token, "DPoP");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain(
      "invalid_dpop_proof",
    );
    const asked = await callDpop(token, "DPoP", await signed(key, token));
    const nonce = asked.headers.get("dpop-nonce") ?? "";
    const other = await createDpopKey();
    const stolen = await callDpop(
      token,
      "DPoP",
      await signed(other, token, nonce),
    );
    expect(stolen.status).toBe(401);
  });

  test("a proof for the forwarded URL instead of the public one is refused", async () => {
    const key = await createDpopKey();
    const token = await tokenFor(
      ada,
      AUDIENCE,
      "console openid email",
      CLIENT,
      key,
    );
    const asked = await callDpop(token, "DPoP", await signed(key, token));
    const nonce = asked.headers.get("dpop-nonce") ?? "";
    const response = await callDpop(
      token,
      "DPoP",
      await key.proof("POST", `http://localhost${CONSOLE_PATH}`, {
        accessToken: token,
        nonce,
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "htu does not match",
    );
  });
});

describe("the console's bearer token", () => {
  test("a request with no token is a 401, with a challenge", async () => {
    const response = await call(ME);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("a valid token reaches `me`", async () => {
    const token = await tokenFor(ada, AUDIENCE, "console openid email");
    const result = await gql(ME, token);
    expect(result.errors).toBeUndefined();
    expect(result.data?.["me"]).toMatchObject({
      user: { id: ada, email: "ada@console.test" },
      platformRole: null,
      memberships: [],
    });
  });

  test("a forged token (signed with an unknown key) is a 401", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const forged = await new SignJWT({ scope: "console" })
      .setProtectedHeader({ alg: "ES256", kid: "forged" })
      .setIssuer(issuerOf(PLATFORM_TENANT_SLUG, origin))
      .setSubject(ada)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    expect((await call(ME, forged)).status).toBe(401);
  });

  test("a tampered payload is a 401", async () => {
    const token = await tokenFor(bob, AUDIENCE, "console");
    const [head, , signature] = token.split(".");
    const payload = btoa(
      JSON.stringify({ sub: ada, aud: AUDIENCE, exp: 9_999_999_999 }),
    ).replaceAll("=", "");
    expect((await call(ME, `${head}.${payload}.${signature}`)).status).toBe(
      401,
    );
  });

  test("a token for another audience is a 401", async () => {
    const token = await tokenFor(ada, OTHER, "read");
    expect((await call(ME, token)).status).toBe(401);
  });

  test("an expired token is a 401", async () => {
    const token = await tokenFor(ada, AUDIENCE, "console");
    expect((await call(ME, token)).status).toBe(200);
    clock.advance(24 * 60 * 60 * 1000);
    expect((await call(ME, token)).status).toBe(401);
    clock.advance(-24 * 60 * 60 * 1000);
  });

  test("a client_credentials token is refused at the token endpoint", async () => {
    // The grant is on only for a tenant with a resource that opted in; the
    // platform tenant has none (the console's own resource cannot opt in).
    const issuer = issuerOf(PLATFORM_TENANT_SLUG, origin);
    const response = await issuers.handle(
      new Request(`${issuer}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa(`${CLIENT.id}:${CLIENT.secret}`)}`,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "console",
          resource: AUDIENCE,
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = errorBody.parse(await response.json());
    expect(body.error).toBe("unsupported_grant_type");
    expect(body["access_token"]).toBeUndefined();
  });

  test("a principal with no user is refused", async () => {
    const userless = createConsoleAuthenticator({
      audience: AUDIENCE,
      publicUrl: PUBLIC_URL,
      serverOfClavix: async () =>
        serverAuthenticating({
          clientId: CONSOLE_CLIENT_ID,
          grantId: "g",
          scopes: ["console"],
          clientName: null,
          bound: null,
          jkt: null,
          subjectType: "client",
          authorizationDetails: [],
        }),
    });
    const request = new Request("http://localhost/", {
      headers: { authorization: "Bearer x" },
    });
    expect(await userless(request)).toBeNull();
  });

  const stubbed = (extra: Partial<OAuthUserPrincipal>) =>
    createConsoleAuthenticator({
      audience: AUDIENCE,
      publicUrl: PUBLIC_URL,
      serverOfClavix: async () =>
        serverAuthenticating({
          clientId: CONSOLE_CLIENT_ID,
          userId: "u1",
          grantId: "g",
          scopes: ["console"],
          clientName: null,
          bound: null,
          jkt: null,
          authorizationDetails: [],
          ...extra,
        }),
    });
  const stubRequest = (scheme: string) =>
    new Request("http://localhost/", {
      headers: { authorization: `${scheme} x` },
    });

  test("an exchanged (delegated) token is refused, bound or not", async () => {
    const actor = { sub: "other-user", clientId: "other-client" };
    expect(await stubbed({ actor })(stubRequest("Bearer"))).toBeNull();
    expect(
      await stubbed({ actor, bound: { type: "dpop", id: "k" }, jkt: "k" })(
        stubRequest("DPoP"),
      ),
    ).toBeNull();
  });

  test("a token with no actor is accepted, bound or not", async () => {
    expect(await stubbed({})(stubRequest("Bearer"))).not.toBeNull();
    expect(
      await stubbed({ bound: { type: "dpop", id: "k" }, jkt: "k" })(
        stubRequest("DPoP"),
      ),
    ).not.toBeNull();
  });

  test("a cookie alone authenticates nothing", async () => {
    const response = await app.request(`http://localhost${CONSOLE_PATH}`, {
      method: "POST",
      headers: {
        ...clientHeaders,
        "content-type": "application/json",
        cookie: "sid=abc",
      },
      body: JSON.stringify({ query: ME }),
    });
    expect(response.status).toBe(401);
  });
});

describe("the guard", () => {
  test("every root field of the real schema has a guard", async () => {
    const { consoleSchema } = await import("./schema");
    const { guards } = await import("./modules");
    const roots = [
      consoleSchema.getQueryType(),
      consoleSchema.getMutationType(),
      consoleSchema.getSubscriptionType(),
    ];
    const fields = roots.flatMap((type) =>
      type === undefined || type === null
        ? []
        : Object.keys(type.getFields()).map((f) => `${type.name}.${f}`),
    );
    expect(fields).toContain("Query.me");
    for (const field of fields) expect(guards).toHaveProperty([field]);
  });

  test("a root field with no guard is denied, even to a platform owner", async () => {
    await access.grantPlatform(ada, "owner");
    const schema = createConsoleSchema({
      typeDefs: "extend type Query { open: String! }",
      resolvers: { Query: { open: () => "secret" } },
    });
    const guarded = createTestApp({
      oauth: issuers,
      console: {
        ...deps,
        schema,
        authenticate: async () => ({
          userId: ada,
          clientId: CONSOLE_CLIENT_ID,
          grantId: "g",
          scopes: [],
          clientName: null,
          bound: null,
          jkt: null,
          authorizationDetails: [],
        }),
      },
    });
    const response = await guarded.request(`http://localhost${CONSOLE_PATH}`, {
      method: "POST",
      headers: {
        ...clientHeaders,
        "content-type": "application/json",
        authorization: "Bearer x",
      },
      body: JSON.stringify({ query: "{ open }" }),
    });
    const result = await gqlOf(response);
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });
});

describe("the verified e-mail gate (ADR-0041)", () => {
  const TENANT = () => `{ tenant(id: "${tenantA}") { id } }`;
  const ME_VERIFIED = "{ me { emailVerified } }";
  let erin = "";

  beforeAll(async () => {
    const janus = await janusIssuers.forRequest(
      new Request(issuerOf(PLATFORM_TENANT_SLUG, origin)),
    );
    erin = (await janus?.create({ email: "erin@console.test" }))?.id ?? "";
    await access.grantTenant(tenantA, erin, "admin");
  });

  test("an unverified admin reads `me`, which says so, and nothing else", async () => {
    const token = await tokenFor(erin, AUDIENCE, "console");
    const me = await gql(ME_VERIFIED, token);
    expect(me.errors).toBeUndefined();
    expect(me.data?.["me"]).toEqual({ emailVerified: false });
    expect(
      (await gql("{ me { user { id email } platformRole } }", token)).errors,
    ).toBeUndefined();
    // The tenants under `me` are tenant data: behind the proof too.
    for (const field of [
      "memberships { role }",
      "switchableTenants { totalCount }",
    ]) {
      const hidden = await gql(`{ me { ${field} } }`, token);
      expect(hidden.errors?.[0]?.extensions?.code).toBe("EMAIL_UNVERIFIED");
    }
    // The plan catalogue is signed-in only, and still needs the proof.
    expect(
      (await gql("{ plans { id } }", token)).errors?.[0]?.extensions?.code,
    ).toBe("EMAIL_UNVERIFIED");

    const refused = await call(TENANT(), token);
    expect(refused.status).toBe(403);
    const body = await gqlOf(refused);
    expect(body.errors?.[0]?.extensions?.code).toBe("EMAIL_UNVERIFIED");
  });

  test("a mutation is refused the same way, before anything is written", async () => {
    const token = await tokenFor(erin, AUDIENCE, "console");
    const refused = await call(
      `mutation { updateTenant(id: "${tenantA}", input: { name: "Hijacked" }) { id } }`,
      token,
    );
    expect(refused.status).toBe(403);
    expect((await gqlOf(refused)).errors?.[0]?.extensions?.code).toBe(
      "EMAIL_UNVERIFIED",
    );
    expect((await findTenant("con-a"))?.name).toBe("A");
  });

  test("the proof opens the console, with the same token, and clearing it closes it again", async () => {
    const token = await tokenFor(erin, AUDIENCE, "console");
    expect((await gql(TENANT(), token)).errors?.[0]?.extensions?.code).toBe(
      "EMAIL_UNVERIFIED",
    );
    await verify(erin);
    const allowed = await gql(TENANT(), token);
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data?.["tenant"]).toEqual({ id: tenantA });
    expect((await gql(ME_VERIFIED, token)).data?.["me"]).toEqual({
      emailVerified: true,
    });
    await verify(erin, false);
    expect((await call(TENANT(), token)).status).toBe(403);
  });

  test("an unverified caller with no role is told to verify, not FORBIDDEN", async () => {
    const janus = await janusIssuers.forRequest(
      new Request(issuerOf(PLATFORM_TENANT_SLUG, origin)),
    );
    const frank = (await janus?.create({ email: "frank@console.test" }))?.id;
    const token = await tokenFor(frank ?? "", AUDIENCE, "console");
    expect((await gql(TENANT(), token)).errors?.[0]?.extensions?.code).toBe(
      "EMAIL_UNVERIFIED",
    );
  });

  test("a platform operator is held to it too: ADR-0039's exception is about the tenant, not the caller", async () => {
    await access.grantPlatform(erin, "owner");
    const token = await tokenFor(erin, AUDIENCE, "console");
    await verify(erin, false);
    expect((await call(TENANT(), token)).status).toBe(403);
    await verify(erin);
    expect((await gql(TENANT(), token)).errors).toBeUndefined();
  });

  test("every root field but `me` has a guard that needs the proof", async () => {
    const { guards } = await import("./modules");
    for (const [field, guard] of Object.entries(guards)) {
      expect(guard.kind === "signedIn" && guard.unverifiedOk === true).toBe(
        field === "Query.me",
      );
    }
  });
});

describe("permissions", () => {
  test("a viewer can view but not edit", async () => {
    await access.grantTenant(tenantA, bob, "viewer");
    expect(await access.can(bob, "view", tenantA)).toBe(true);
    expect(await access.can(bob, "edit", tenantA)).toBe(false);
    expect(await access.can(bob, "manage", tenantA)).toBe(false);
  });

  test("an admin edits but does not manage", async () => {
    await access.grantTenant(tenantA, bob, "admin");
    expect(await access.can(bob, "edit", tenantA)).toBe(true);
    expect(await access.can(bob, "manage", tenantA)).toBe(false);
  });

  test("tenant A's admin cannot touch tenant B", async () => {
    expect(await access.can(bob, "view", tenantB)).toBe(false);
    expect(await access.can(bob, "edit", tenantB)).toBe(false);
  });

  test("a platform role carries over to every tenant", async () => {
    await access.grantPlatform(bob, "viewer");
    expect(await access.can(bob, "view", tenantB)).toBe(true);
    expect(await access.can(bob, "edit", tenantB)).toBe(false);
    expect(await access.canPlatform(bob, "view")).toBe(true);
    expect(await access.platformRole(bob)).toBe("viewer");
  });

  test("me lists the direct memberships and the platform role", async () => {
    const token = await tokenFor(bob, AUDIENCE, "console");
    const result = await gql(
      "{ me { platformRole memberships { tenant { slug } role } } }",
      token,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.["me"]).toEqual({
      platformRole: "VIEWER",
      memberships: [{ tenant: { slug: "con-a" }, role: "ADMIN" }],
    });
  });
});

describe("isolation from the hosted pages' API", () => {
  test("the console SDL is not served on /graphql", async () => {
    const { schema } = await import("@/http/schema");
    expect(schema.getType("Me")).toBeUndefined();
    expect(schema.getType("ConsoleUser")).toBeUndefined();
  });
});

describe("the console seed", () => {
  test("the migration made the resource and the client, idempotently", async () => {
    const { seedConsole } = await import("@/migrations/console-seed");
    const stored = await resourcesFor(
      defined(
        await tenantResolver.resolveHost(
          `${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`,
        ),
        "the platform tenant",
      ),
    );
    expect(Object.keys(stored)).toContain(AUDIENCE);
    expect(stored[AUDIENCE]?.scopes).toContain("console");
    // A second run creates nothing and shows no secret.
    expect((await seedConsole(oauthDb, origin)).clientSecret).toBeNull();
  });

  test("every tenant is linked to the platform", async () => {
    // Created through the service: linked by `onCreated`; bob is a platform viewer.
    expect(await access.can(bob, "view", tenantB)).toBe(true);
    // Ada is a platform owner (the guard spec): she manages the new tenant.
    expect(await access.can(ada, "manage", tenantB)).toBe(true);
  });
});

describe("operators:grant", () => {
  const recorded: { type: string; id: string }[] = [];
  const invited: { email: string; role: string }[] = [];
  const deps = {
    access,
    lock: noUserLock,
    findByEmail: async (email: string) =>
      email === "bob@console.test"
        ? { id: bob, email, active: true }
        : email === "off@console.test"
          ? { id: "off-user", email, active: false }
          : null,
    invite: async (email: string, role: string) => {
      invited.push({ email, role });
      return { id: "inv-1" };
    },
    record: async (target: { type: string; id: string }) => {
      recorded.push(target);
    },
  };

  test("grants the platform role to a known e-mail, refuses an unknown one", async () => {
    const { grantOperator, parseOperatorArgs } = await import("./operators");
    expect(parseOperatorArgs(["--email", "bob@console.test"])).toEqual({
      email: "bob@console.test",
      role: "owner",
      create: false,
    });
    await grantOperator(deps, {
      email: "bob@console.test",
      role: "owner",
      create: false,
    });
    expect(await access.platformRole(bob)).toBe("owner");
    expect(recorded).toEqual([{ type: "user", id: bob }]);
    await expect(
      grantOperator(deps, {
        email: "nobody@console.test",
        role: "owner",
        create: false,
      }),
    ).rejects.toThrow("--create");
    expect(invited).toEqual([]);
    expect(() => parseOperatorArgs([])).toThrow();
  });

  test("refuses a disabled account, with or without --create, and grants nothing", async () => {
    const { grantOperator } = await import("./operators");
    for (const create of [false, true]) {
      await expect(
        grantOperator(deps, {
          email: "off@console.test",
          role: "owner",
          create,
        }),
      ).rejects.toThrow("disabled");
    }
    expect(await access.platformRole("off-user")).toBeNull();
  });

  test("the check and the grant run under the user's lock, on a fresh read", async () => {
    const { grantOperator } = await import("./operators");
    const locked: string[] = [];
    let reads = 0;
    const result = await grantOperator(
      {
        ...deps,
        // Active at the first read, disabled once the lock is held.
        findByEmail: async (email) => {
          const found = await deps.findByEmail(email);
          reads += 1;
          return found === null ? null : { ...found, active: reads === 1 };
        },
        lock: async (id, work) => {
          locked.push(id);
          return work();
        },
      },
      { email: "bob@console.test", role: "viewer", create: false },
    ).catch((error: unknown) => error);
    expect(locked).toEqual([bob]);
    expect(String(result)).toContain("disabled");
  });

  test("an account deleted or replaced under the lock is not granted", async () => {
    const { grantOperator } = await import("./operators");
    for (const fresh of [null, { id: "other-id" }]) {
      let reads = 0;
      const granted: string[] = [];
      const error = await grantOperator(
        {
          ...deps,
          findByEmail: async (email) => {
            const found = await deps.findByEmail(email);
            reads += 1;
            if (reads === 1 || found === null) return found;
            return fresh === null ? null : { ...found, ...fresh };
          },
          access: {
            grantPlatform: async (id) => {
              granted.push(id);
            },
          },
          lock: (_id, work) => work(),
        },
        { email: "bob@console.test", role: "viewer", create: false },
      ).catch((e: unknown) => e);
      expect(String(error)).toContain("run the command again");
      expect(granted).toEqual([]);
    }
  });

  test("--create invites an unknown e-mail and records it; a known one is granted, not invited", async () => {
    const { grantOperator, parseOperatorArgs } = await import("./operators");
    expect(
      parseOperatorArgs(["--email", "new@console.test", "--create"]).create,
    ).toBe(true);
    recorded.length = 0;
    const result = await grantOperator(deps, {
      email: "new@console.test",
      role: "admin",
      create: true,
    });
    expect(result).toEqual({
      invitationId: "inv-1",
      email: "new@console.test",
      role: "admin",
      invited: true,
    });
    expect(invited).toEqual([{ email: "new@console.test", role: "admin" }]);
    expect(recorded).toEqual([{ type: "invitation", id: "inv-1" }]);
    const known = await grantOperator(deps, {
      email: "bob@console.test",
      role: "owner",
      create: true,
    });
    expect("userId" in known).toBe(true);
    expect(invited).toHaveLength(1);
  });

  test("the script's wiring invites in the operator scope and records the event", async () => {
    const { operatorGrantDeps } = await import("./operators");
    const invites: unknown[] = [];
    const events: AdminEventInput[] = [];
    const wired = operatorGrantDeps({
      findByEmail: async () => null,
      access,
      lock: noUserLock,
      invitations: {
        invite: async (input) => {
          invites.push(input);
          return {
            id: "inv-9",
            email: input.email,
            role: input.role,
            invitedAt: new Date(),
            expiresAt: new Date(),
            invitedBy: null,
          };
        },
      },
      recorder: {
        record: async (event) => {
          events.push(event);
        },
      },
    });
    expect(await wired.invite("c@console.test", "viewer")).toMatchObject({
      id: "inv-9",
    });
    expect(invites).toEqual([
      {
        scope: "operator",
        organization: "Clavix",
        email: "c@console.test",
        role: "viewer",
        invitedBy: null,
      },
    ]);
    await wired.record({ type: "invitation", id: "inv-9" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "cli:operators:grant",
      action: "operator.grant",
      tenantId: null,
      target: { type: "invitation", id: "inv-9" },
    });
    expect(typeof events[0]?.requestId).toBe("string");
  });
});

describe("the guards over HTTP", () => {
  const specGuards = {
    "Query.tenantEdit": onTenant("edit", (args) => String(args["id"])),
    "Query.platformView": onPlatform("view"),
    "Mutation.tenantRename": onTenant("edit", (args) => String(args["id"])),
  };
  const limix = consoleLimixWith(specGuards);
  const schema = createConsoleSchema({
    typeDefs: `extend type Query {
      tenantEdit(id: ID!): String!
      platformView: String!
    }
    extend type Mutation { tenantRename(id: ID!): String! }`,
    resolvers: {
      Query: { tenantEdit: () => "ok", platformView: () => "ok" },
      Mutation: { tenantRename: () => "ok" },
    },
    guards: specGuards,
  });
  const as = (userId: string, query: string, scopes = ["console"]) =>
    createTestApp({
      oauth: issuers,
      console: {
        ...deps,
        schema,
        limix,
        authenticate: async () => ({
          userId,
          clientId: CONSOLE_CLIENT_ID,
          grantId: "g",
          scopes,
          clientName: null,
          bound: null,
          jkt: null,
          authorizationDetails: [],
        }),
      },
    })
      .request(`http://localhost${CONSOLE_PATH}`, {
        method: "POST",
        headers: {
          ...clientHeaders,
          "content-type": "application/json",
          authorization: "Bearer x",
        },
        body: JSON.stringify({ query }),
      })
      .then(gqlOf);
  const code = (r: GqlResult) => r.errors?.[0]?.extensions?.code;

  test("a tenant admin edits their tenant, not another", async () => {
    const carol =
      (
        await (
          await janusIssuers.forRequest(
            new Request(issuerOf(PLATFORM_TENANT_SLUG, origin)),
          )
        )?.create({ email: "carol@console.test" })
      )?.id ?? "";
    await verify(carol);
    await access.grantTenant(tenantA, carol, "admin");
    expect((await as(carol, `{ tenantEdit(id: "${tenantA}") }`)).data).toEqual({
      tenantEdit: "ok",
    });
    expect(code(await as(carol, `{ tenantEdit(id: "${tenantB}") }`))).toBe(
      "FORBIDDEN",
    );
    expect(code(await as(carol, "{ platformView }"))).toBe("FORBIDDEN");
  });

  test("a write reads its tenant once, and the next write on it reads afresh", async () => {
    const eve =
      (
        await (
          await janusIssuers.forRequest(
            new Request(issuerOf(PLATFORM_TENANT_SLUG, origin)),
          )
        )?.create({ email: "eve@console.test" })
      )?.id ?? "";
    await verify(eve);
    await access.grantTenant(tenantA, eve, "admin");
    let reads = 0;
    const counting = createTestApp({
      oauth: issuers,
      console: {
        ...deps,
        directory: {
          ...deps.directory,
          tenantsByIds: (ids) => {
            reads += 1;
            return deps.directory.tenantsByIds(ids);
          },
        },
        schema,
        limix,
        authenticate: async () => ({
          userId: eve,
          clientId: CONSOLE_CLIENT_ID,
          grantId: "g",
          scopes: ["console"],
          clientName: null,
          bound: null,
          jkt: null,
          authorizationDetails: [],
        }),
      },
    });
    const call = (query: string) =>
      counting.request(`http://localhost${CONSOLE_PATH}`, {
        method: "POST",
        headers: {
          ...clientHeaders,
          "content-type": "application/json",
          authorization: "Bearer x",
        },
        body: JSON.stringify({ query }),
      });
    await call(`mutation { tenantRename(id: "${tenantA}") }`);
    expect(reads).toBe(1);
    // Mutations run one after the other: each reads the tenant's state afresh.
    await call(
      `mutation { first: tenantRename(id: "${tenantA}") second: tenantRename(id: "${tenantA}") }`,
    );
    expect(reads).toBe(3);
  });

  test("a viewer cannot edit", async () => {
    const dan =
      (
        await (
          await janusIssuers.forRequest(
            new Request(issuerOf(PLATFORM_TENANT_SLUG, origin)),
          )
        )?.create({ email: "dan@console.test" })
      )?.id ?? "";
    await verify(dan);
    await access.grantTenant(tenantA, dan, "viewer");
    expect(code(await as(dan, `{ tenantEdit(id: "${tenantA}") }`))).toBe(
      "FORBIDDEN",
    );
  });

  test("a platform viewer sees the platform field", async () => {
    expect((await as(bob, "{ platformView }")).data).toEqual({
      platformView: "ok",
    });
  });
});

describe("authentication failures", () => {
  const withAuth = (authenticate: () => Promise<never>) =>
    createTestApp({
      oauth: issuers,
      console: { ...deps, authenticate },
    }).request(`http://localhost${CONSOLE_PATH}`, {
      method: "POST",
      headers: {
        ...clientHeaders,
        "content-type": "application/json",
        authorization: "Bearer x",
      },
      body: JSON.stringify({ query: ME }),
    });

  test("a store outage is a 503, not a 401", async () => {
    expect(
      (
        await withAuth(async () => {
          throw new Error("down");
        })
      ).status,
    ).toBe(503);
  });

  test("a console-audience token of another client is a 401", async () => {
    const token = await tokenFor(ada, AUDIENCE, "console", FOREIGN);
    expect((await call(ME, token)).status).toBe(401);
  });

  test("a token without the console scope is a 401", async () => {
    const token = await tokenFor(ada, AUDIENCE, "openid");
    expect((await call(ME, token)).status).toBe(401);
  });
});
