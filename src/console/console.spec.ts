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
import type { AdminEventInput } from "@/console/admin-events/recorder";
import { registerResource } from "@/modules/resources/register-resource";
import { resources } from "@/modules/resources/resources.model";
import { scopes } from "@/modules/resources/scopes.model";
import { issuerOf, partitionOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { tenants } from "@/modules/tenants/tenants.model";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { createConsoleAuthenticator } from "./auth";
import { onPlatform, onTenant } from "./guard";
import {
  CONSOLE_CLIENT_ID,
  CONSOLE_PATH,
  consoleAudience,
  consoleRedirectUri,
} from "./identity";
import { createConsoleSchema } from "./schema";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const AUDIENCE = consoleAudience(origin);
const OTHER = "https://other.test/api";
// The console client is the migration's: its seed resets it to this URI.
const REDIRECT = consoleRedirectUri(origin);
const VERIFIER = "v".repeat(64);
const CLIENT = { id: CONSOLE_CLIENT_ID, secret: "" };
const FOREIGN = { id: "spec-foreign", secret: "" };

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
  const exchanged = await issuers.handle(
    new Request(`${issuer}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${client.id}:${client.secret}`)}`,
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
      // The migration's `console` client may already be there: a fresh secret.
      rotateSecret: true,
    },
  );
  CLIENT.secret = registered.clientSecret ?? "";
  FOREIGN.secret =
    (
      await registerClient(
        { db: oauthDb, findTenant },
        {
          tenant: PLATFORM_TENANT_SLUG,
          name: "Spec foreign",
          clientId: FOREIGN.id,
          redirectUris: [REDIRECT],
          type: "confidential",
        },
      )
    ).clientSecret ?? "";
  await registerResource(
    {
      collection: getCollection(oauthDb, resources),
      scopes: getCollection(oauthDb, scopes),
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
    // The console client has no user behind a client_credentials token: the
    // token endpoint offers authorization_code and refresh_token only, whatever
    // grant types a client records.
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
    const body = (await response.json()) as {
      error?: string;
      access_token?: string;
    };
    expect(body.error).toBe("unsupported_grant_type");
    expect(body.access_token).toBeUndefined();
  });

  test("a principal with no user is refused", async () => {
    const userless = createConsoleAuthenticator({
      audience: AUDIENCE,
      serverOfClavix: async () =>
        ({
          authenticate: async () => ({
            clientId: CONSOLE_CLIENT_ID,
            grantId: "g",
            scopes: ["console"],
            clientName: null,
            bound: null,
          }),
        }) as never,
    });
    const request = new Request("http://localhost/", {
      headers: { authorization: "Bearer x" },
    });
    expect(await userless(request)).toBeNull();
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
          clientId: CONSOLE_CLIENT_ID,
          grantId: "g",
          scopes: [],
          clientName: null,
          bound: null,
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
    expect((await gql(ME, token)).errors).toBeUndefined();
    // The plan catalogue is signed-in only, and still needs the proof.
    expect(
      ((await (await call("{ plans { id } }", token)).json()) as GqlResult)
        .errors?.[0]?.extensions?.code,
    ).toBe("EMAIL_UNVERIFIED");

    const refused = await call(TENANT(), token);
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as GqlResult;
    expect(body.errors?.[0]?.extensions?.code).toBe("EMAIL_UNVERIFIED");
  });

  test("a mutation is refused the same way, before anything is written", async () => {
    const token = await tokenFor(erin, AUDIENCE, "console");
    const refused = await call(
      `mutation { updateTenant(id: "${tenantA}", input: { name: "Hijacked" }) { id } }`,
      token,
    );
    expect(refused.status).toBe(403);
    expect(
      ((await refused.json()) as GqlResult).errors?.[0]?.extensions?.code,
    ).toBe("EMAIL_UNVERIFIED");
    expect((await findTenant("con-a"))?.name).toBe("A");
  });

  test("the proof opens the console, with the same token, and clearing it closes it again", async () => {
    const token = await tokenFor(erin, AUDIENCE, "console");
    expect(
      ((await (await call(TENANT(), token)).json()) as GqlResult).errors?.[0]
        ?.extensions?.code,
    ).toBe("EMAIL_UNVERIFIED");
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
    expect(
      ((await (await call(TENANT(), token)).json()) as GqlResult).errors?.[0]
        ?.extensions?.code,
    ).toBe("EMAIL_UNVERIFIED");
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
  const recorded: { type: string; id: string }[] = [];
  const invited: { email: string; role: string }[] = [];
  const deps = {
    access,
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
          clientId: CONSOLE_CLIENT_ID,
          grantId: "g",
          scopes,
          clientName: null,
          bound: null,
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

  test("a console-audience token of another client is a 401", async () => {
    const token = await tokenFor(ada, AUDIENCE, "console", FOREIGN);
    expect((await call(ME, token)).status).toBe(401);
  });

  test("a token without the console scope is a 401", async () => {
    const token = await tokenFor(ada, AUDIENCE, "openid");
    expect((await call(ME, token)).status).toBe(401);
  });
});
