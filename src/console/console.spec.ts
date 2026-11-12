import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fixedClock } from "@softistx/janus";
import {
  createMemorySigningKeys,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { getCollection } from "@softistx/mongo";
import { generateKeyPair, SignJWT } from "jose";
import { createApp } from "@/app";
import { registerClient } from "@/clients/register-client";
import { access } from "@/config/access";
import { createConsoleDeps } from "@/config/console";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { resourcesFor } from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { authFor, claimsFor, janusIssuers } from "@/config/users";
import { registerResource } from "@/modules/resources/register-resource";
import { resources } from "@/modules/resources/resources.model";
import { issuerOf, partitionOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { tenants } from "@/modules/tenants/tenants.model";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { createConsoleAuthenticator } from "./auth";
import { onPlatform, onTenant } from "./guard";
import { CONSOLE_PATH, consoleAudience } from "./identity";
import { createConsoleSchema } from "./schema";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const AUDIENCE = consoleAudience(origin);
const OTHER = "https://other.test/api";
const REDIRECT = "https://console.example/callback";
const VERIFIER = "v".repeat(64);
const CLIENT = { id: "spec-console", secret: "" };

const clock = fixedClock(new Date());
const keys = new Map<string, SigningKeyStore>();
const issuers = createClavixOAuthIssuers({
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
const app = createApp({
  oauth: issuers,
  console: {
    ...deps,
    authenticate: createConsoleAuthenticator({
      audience: AUDIENCE,
      serverOfClavix,
    }),
  },
});

const findTenant = (slug: string) =>
  getCollection(oauthDb, tenants).findFirst({ slug });

interface GqlResult {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}
const call = (query: string, token?: string) =>
  app.request(`http://localhost${CONSOLE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ query }),
  });
const gql = async (query: string, token?: string) =>
  (await (await call(query, token)).json()) as GqlResult;

const ME = "{ me { user { id email } platformRole memberships { role } } }";

// A real token: authorize on the clavix issuer, approve as `userId`, exchange.
async function tokenFor(
  userId: string,
  resource: string,
  scope: string,
): Promise<string> {
  const server = await serverOfClavix();
  if (server === null) throw new Error("no clavix server");
  const issuer = issuerOf(PLATFORM_TENANT_SLUG, origin);
  const authorize = await issuers.handle(
    new Request(
      `${issuer}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: CLIENT.id,
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
  const exchanged = await issuers.handle(
    new Request(`${issuer}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${CLIENT.id}:${CLIENT.secret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(redirectTo).searchParams.get("code") ?? "",
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        resource,
      }),
    }),
  );
  const body = (await exchanged.json()) as { access_token?: string };
  if (body.access_token === undefined) {
    throw new Error(`no token: ${JSON.stringify(body)}`);
  }
  return body.access_token;
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
    { db: oauthDb, findTenant },
    {
      tenant: PLATFORM_TENANT_SLUG,
      name: "Spec console",
      clientId: CLIENT.id,
      redirectUris: [REDIRECT],
      type: "confidential",
    },
  );
  CLIENT.secret = registered.clientSecret ?? "";
  await registerResource(
    {
      collection: getCollection(oauthDb, resources),
      findTenant,
      issuerOf: (slug) => issuerOf(slug, origin),
    },
    {
      tenant: PLATFORM_TENANT_SLUG,
      uri: OTHER,
      name: "Other",
      scopes: ["read"],
    },
  );
  const janus = await janusIssuers.forRequest(
    new Request(issuerOf(PLATFORM_TENANT_SLUG, origin)),
  );
  if (janus === null) throw new Error("no janus for clavix");
  ada = (await janus.create({ email: "ada@console.test", name: "Ada" })).id;
  bob = (await janus.create({ email: "bob@console.test", name: "Bob" })).id;
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

  test("a cookie alone authenticates nothing", async () => {
    const response = await app.request(`http://localhost${CONSOLE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "sid=abc" },
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
    const guarded = createApp({
      oauth: issuers,
      console: {
        ...deps,
        schema,
        authenticate: async () => ({
          userId: ada,
          clientId: "c",
          grantId: "g",
          scopes: [],
        }),
      },
    });
    const response = await guarded.request(`http://localhost${CONSOLE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer x",
      },
      body: JSON.stringify({ query: "{ open }" }),
    });
    const result = (await response.json()) as GqlResult;
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
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
      (await tenantResolver.resolveHost(
        `${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`,
      )) as never,
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
  test("grants the platform role to a known e-mail, refuses an unknown one", async () => {
    const { grantOperator, parseOperatorArgs } = await import("./operators");
    const deps = {
      access,
      findByEmail: async (email: string) =>
        email === "bob@console.test" ? { id: bob, email } : null,
    };
    expect(parseOperatorArgs(["--email", "bob@console.test"])).toEqual({
      email: "bob@console.test",
      role: "owner",
    });
    await grantOperator(deps, { email: "bob@console.test", role: "owner" });
    expect(await access.platformRole(bob)).toBe("owner");
    await expect(
      grantOperator(deps, { email: "nobody@console.test", role: "owner" }),
    ).rejects.toThrow();
    expect(() => parseOperatorArgs([])).toThrow();
  });
});

describe("the guards over HTTP", () => {
  const schema = createConsoleSchema({
    typeDefs: `extend type Query {
      tenantEdit(id: ID!): String!
      platformView: String!
    }`,
    resolvers: {
      Query: { tenantEdit: () => "ok", platformView: () => "ok" },
    },
    guards: {
      "Query.tenantEdit": onTenant("edit", (args) => String(args["id"])),
      "Query.platformView": onPlatform("view"),
    },
  });
  const as = (userId: string, query: string, scopes = ["console"]) =>
    createApp({
      oauth: issuers,
      console: {
        ...deps,
        schema,
        authenticate: async () => ({
          userId,
          clientId: "c",
          grantId: "g",
          scopes,
        }),
      },
    })
      .request(`http://localhost${CONSOLE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer x",
        },
        body: JSON.stringify({ query }),
      })
      .then((r) => r.json() as Promise<GqlResult>);
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
    await access.grantTenant(tenantA, carol, "admin");
    expect((await as(carol, `{ tenantEdit(id: "${tenantA}") }`)).data).toEqual({
      tenantEdit: "ok",
    });
    expect(code(await as(carol, `{ tenantEdit(id: "${tenantB}") }`))).toBe(
      "FORBIDDEN",
    );
    expect(code(await as(carol, "{ platformView }"))).toBe("FORBIDDEN");
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
    createApp({ oauth: issuers, console: { ...deps, authenticate } }).request(
      `http://localhost${CONSOLE_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer x",
        },
        body: JSON.stringify({ query: ME }),
      },
    );

  test("a store outage is a 503, not a 401", async () => {
    expect(
      (
        await withAuth(async () => {
          throw new Error("down");
        })
      ).status,
    ).toBe(503);
  });

  test("a token without the console scope is a 401", async () => {
    const token = await tokenFor(ada, AUDIENCE, "openid");
    expect((await call(ME, token)).status).toBe(401);
  });
});
