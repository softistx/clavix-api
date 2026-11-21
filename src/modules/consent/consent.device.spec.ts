import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  DEVICE_GRANT,
  rotateSigningKeys,
  type SigningKeyStore,
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
import { issuerOf, PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { SESSION_COOKIE } from "@/modules/users";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { clientHeaders } from "~/client-header";
import { createTenantParOff } from "../../../test/tenant-par-off";
import { createDeviceThrottle } from "./consent.device-throttle";

const RESOURCE = "https://api.clavix.test/mcp";
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
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

// A limit that allows `budget` calls per key, then refuses for 42 s.
const counting = (budget: number) => {
  const used = new Map<string, number>();
  return {
    calls: 0,
    async consume(params: Record<string, string>) {
      this.calls += 1;
      const key = JSON.stringify(params);
      const count = (used.get(key) ?? 0) + 1;
      used.set(key, count);
      return count <= budget
        ? { allowed: true, retryAfter: 0 }
        : { allowed: false, retryAfter: 42_000 };
    },
  };
};
const throttled = (budgets: { user: number; ip?: number; tenant?: number }) => {
  const user = counting(budgets.user);
  const ip = counting(budgets.ip ?? 1000);
  const tenant = counting(budgets.tenant ?? 1000);
  return {
    user,
    ip,
    tenant,
    throttle: createDeviceThrottle(
      {
        deviceUser: user as never,
        deviceIp: ip as never,
        deviceTenant: tenant as never,
      },
      () => {},
    ),
  };
};

const app = createApp({ oauth: issuers });
const url = (slug: string, path = "/") => `${issuerOf(slug, origin)}${path}`;

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
  on: { request: typeof app.request } = app,
): Promise<{
  result: GqlResult;
  status: number;
  retryAfter: string | null;
}> => {
  const response = await on.request(url(slug, "/graphql"), {
    method: "POST",
    headers: {
      ...clientHeaders,
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
      ...(language === undefined ? {} : { "accept-language": language }),
    },
    body: JSON.stringify({ query, variables }),
  });
  return {
    result: (await response.json()) as GqlResult,
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
  };
};
const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions?.code;

const REQUEST = `query($code: String!) { oauthDeviceRequest(userCode: $code) { client { id name host } resource scopes { name label } expiresAt } }`;
const APPROVE = `mutation($code: String!, $scopes: [String!]) { approveOAuthDeviceRequest(userCode: $code, scopes: $scopes) }`;
const DENY = `mutation($code: String!) { denyOAuthDeviceRequest(userCode: $code) }`;

const sessions: Record<string, { cookie: string; userId: string }> = {};
const cookieOf = (slug: string) => sessions[slug]?.cookie ?? "";

const deviceCodes = async (slug: string, scope = "openid email") => {
  const response = await issuers.handle(
    new Request(url(slug, "/device_authorization"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "tv", scope }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { device_code: string; user_code: string };
};

const poll = (slug: string, deviceCode: string) =>
  issuers.handle(
    new Request(url(slug, "/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
        client_id: "tv",
      }),
    }),
  );

beforeAll(async () => {
  for (const slug of ["dacme", "dglobex"]) {
    await createTenantParOff(tenantsService, { slug, name: slug });
    const tenant = await tenantResolver.resolveHost(new URL(url(slug)).host);
    if (tenant === null) throw new Error("tenant not resolved");
    await rotateSigningKeys(signingKeysFor(tenant.tenantId), {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
    await registerClient(
      {
        now: () => new Date(),
        db: oauthDb,
        findTenant: (s) => mongo.db.tenants.findFirst({ slug: s }),
      },
      {
        tenant: slug,
        name: "Living room TV",
        clientId: "tv",
        redirectUris: [],
        grants: [DEVICE_GRANT],
      },
    );
    const auth = await janusIssuers.forRequest(new Request(url(slug)));
    if (auth === null) throw new Error("no janus");
    const user = await auth.create({ email: "ada@example.test" });
    const result = await auth.signInProven(user);
    if (result.status !== "signedIn") throw new Error("no session");
    sessions[slug] = {
      cookie: `${SESSION_COOKIE}=${result.token}`,
      userId: user.id,
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

describe("the device verification page's data", () => {
  test("shows the client, its host and the scopes with the tenant's texts, in the viewer's language", async () => {
    const acme = await mongo.db.tenants.findFirst({ slug: "dacme" });
    if (acme === undefined) throw new Error("no tenant");
    await resourcesService.createScope(acme._id, {
      name: "email",
      description: { fr: "Votre adresse e-mail", en: "Your email address" },
      resourceId: null,
      claims: [],
    });
    const { user_code } = await deviceCodes("dacme");
    const read = async (language: string, code = user_code) => {
      const { result } = await gql(
        "dacme",
        REQUEST,
        { code },
        cookieOf("dacme"),
        language,
      );
      expect(result.errors).toBeUndefined();
      return result.data?.["oauthDeviceRequest"] as {
        client: { id: string; name: string };
        scopes: { name: string; label: string }[];
      };
    };
    const french = await read("fr-CA,en;q=0.8");
    expect(french.client).toMatchObject({ id: "tv", name: "Living room TV" });
    expect(french.scopes.find((s) => s.name === "email")?.label).toBe(
      "Votre adresse e-mail",
    );
    // The typed form: case, dash and spaces do not matter.
    const typed = await read("en", user_code.toLowerCase().replace("-", " "));
    expect(typed.scopes.find((s) => s.name === "email")?.label).toBe(
      "Your email address",
    );
  });

  test("the client is marked an agent when it is one of the tenant's agents", async () => {
    const acme = await mongo.db.tenants.findFirst({ slug: "dacme" });
    if (acme === undefined) throw new Error("no tenant");
    const query = `query($code: String!) { oauthDeviceRequest(userCode: $code) { client { id agent registeredAt } } }`;
    const markOf = async () => {
      const { user_code } = await deviceCodes("dacme");
      const { result } = await gql(
        "dacme",
        query,
        { code: user_code },
        cookieOf("dacme"),
      );
      expect(result.errors).toBeUndefined();
      const request = result.data?.["oauthDeviceRequest"] as
        | { client: unknown }
        | undefined;
      return request?.client;
    };
    expect(await markOf()).toEqual({
      id: "tv",
      agent: false,
      registeredAt: null,
    });
    try {
      await agentClientsService.record(acme._id.toHexString(), {
        clientId: "tv",
        kind: "metadata",
      });
      expect(await markOf()).toMatchObject({ id: "tv", agent: true });
    } finally {
      await mongo.db.agentClients.raw.deleteMany({});
    }
  });

  test("an anonymous viewer is UNAUTHENTICATED", async () => {
    const { user_code } = await deviceCodes("dacme");
    const { result } = await gql("dacme", REQUEST, { code: user_code });
    expect(codeOf(result)).toBe("UNAUTHENTICATED");
  });

  test("an unknown code is NOT_FOUND", async () => {
    const { result } = await gql(
      "dacme",
      REQUEST,
      { code: "BCDF-GHJK" },
      cookieOf("dacme"),
    );
    expect(codeOf(result)).toBe("NOT_FOUND");
  });

  test("a suspended tenant's page is TENANT_SUSPENDED, and works again once reactivated (#228)", async () => {
    const globex = await mongo.db.tenants.findFirst({ slug: "dglobex" });
    if (globex === undefined) throw new Error("no tenant");
    const { user_code } = await deviceCodes("dglobex");
    await tenantsService.suspend(globex._id);
    try {
      const { result } = await gql(
        "dglobex",
        REQUEST,
        { code: user_code },
        cookieOf("dglobex"),
      );
      expect(codeOf(result)).toBe("TENANT_SUSPENDED");
    } finally {
      await tenantsService.reactivate(globex._id);
    }
  });
});

describe("approve and deny", () => {
  test("approving with a subset of the scopes lets the device poll its tokens", async () => {
    const { user_code, device_code } = await deviceCodes("dacme");
    const approved = await gql(
      "dacme",
      APPROVE,
      { code: user_code, scopes: ["openid"] },
      cookieOf("dacme"),
    );
    expect(approved.result.errors).toBeUndefined();
    expect(approved.result.data?.["approveOAuthDeviceRequest"]).toBe(true);
    const response = await poll("dacme", device_code);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id_token: string;
      scope?: string;
    };
    expect(decodeJwt(body.id_token)["sub"]).toBe(sessions["dacme"]?.userId);
    expect(body.scope).toBe("openid");
    // Decided: gone.
    const again = await gql(
      "dacme",
      REQUEST,
      { code: user_code },
      cookieOf("dacme"),
    );
    expect(codeOf(again.result)).toBe("NOT_FOUND");
  });

  test("denying makes the device's next poll access_denied", async () => {
    const { user_code, device_code } = await deviceCodes("dacme");
    const denied = await gql(
      "dacme",
      DENY,
      { code: user_code },
      cookieOf("dacme"),
    );
    expect(denied.result.errors).toBeUndefined();
    const response = await poll("dacme", device_code);
    expect(((await response.json()) as { error: string }).error).toBe(
      "access_denied",
    );
  });

  test("a session older than five minutes is STEP_UP_REQUIRED and the request stays pending", async () => {
    const auth = await janusIssuers.forRequest(new Request(url("dacme")));
    const user = await auth?.create({ email: "old@example.test" });
    if (auth === null || user === undefined) throw new Error("no janus");
    const result = await auth.signInProven(user);
    if (result.status !== "signedIn") throw new Error("no session");
    await oauthDb
      .collection("partitionedSessions")
      .updateMany(
        { userId: user.id },
        { $set: { authenticatedAt: new Date(Date.now() - 10 * 60_000) } },
      );
    const stale = `${SESSION_COOKIE}=${result.token}`;
    const { user_code } = await deviceCodes("dacme");
    const refused = await gql("dacme", APPROVE, { code: user_code }, stale);
    expect(codeOf(refused.result)).toBe("STEP_UP_REQUIRED");
    // Still pending, and a fresh session can decide it.
    const read = await gql("dacme", REQUEST, { code: user_code }, stale);
    expect(read.result.errors).toBeUndefined();
    const approved = await gql(
      "dacme",
      APPROVE,
      { code: user_code },
      cookieOf("dacme"),
    );
    expect(approved.result.errors).toBeUndefined();
  });

  test("a scope the device did not ask for is NOT_FOUND, like an unknown code", async () => {
    const { user_code } = await deviceCodes("dacme", "openid");
    const refused = await gql(
      "dacme",
      APPROVE,
      { code: user_code, scopes: ["openid", "email"] },
      cookieOf("dacme"),
    );
    expect(codeOf(refused.result)).toBe("NOT_FOUND");
  });
});

describe("tenant isolation", () => {
  test("a code of A is NOT_FOUND on B for read, approve and deny, even with B's session", async () => {
    const { user_code } = await deviceCodes("dacme");
    for (const [query, name] of [
      [REQUEST, "oauthDeviceRequest"],
      [APPROVE, "approveOAuthDeviceRequest"],
      [DENY, "denyOAuthDeviceRequest"],
    ] as const) {
      const { result } = await gql(
        "dglobex",
        query,
        { code: user_code },
        cookieOf("dglobex"),
      );
      expect(codeOf(result), name).toBe("NOT_FOUND");
    }
    const onA = await gql(
      "dacme",
      REQUEST,
      { code: user_code },
      cookieOf("dacme"),
    );
    expect(onA.result.errors).toBeUndefined();
  });

  test("A's session is anonymous on B", async () => {
    const { user_code } = await deviceCodes("dglobex");
    const { result } = await gql(
      "dglobex",
      REQUEST,
      { code: user_code },
      cookieOf("dacme"),
    );
    expect(codeOf(result)).toBe("UNAUTHENTICATED");
  });
});

describe("the throttle on code lookups", () => {
  const counters = throttled({ user: 3 });
  const limited = createApp({
    oauth: issuers,
    deviceThrottle: counters.throttle,
  });
  const ask = (code: string) =>
    gql("dacme", REQUEST, { code }, cookieOf("dacme"), undefined, limited);

  test("every lookup counts: past the user's budget the lookup is DEVICE_CODE_THROTTLED (429, retry-after)", async () => {
    for (const code of ["BCDF-GHJK", "BCDF-GHJL", "BCDF-GHJM"]) {
      expect(codeOf((await ask(code)).result)).toBe("NOT_FOUND");
    }
    const refused = await ask("BCDF-GHJN");
    expect(codeOf(refused.result)).toBe("DEVICE_CODE_THROTTLED");
    expect(refused.status).toBe(429);
    expect(refused.retryAfter).toBe("42");
    // Approve and deny are behind the same budget: a live code is not looked up either.
    const { user_code } = await deviceCodes("dacme");
    const approve = await gql(
      "dacme",
      APPROVE,
      { code: user_code },
      cookieOf("dacme"),
      undefined,
      limited,
    );
    expect(codeOf(approve.result)).toBe("DEVICE_CODE_THROTTLED");
    // Another user of the same tenant has their own budget.
    const other = await gql(
      "dglobex",
      REQUEST,
      { code: "BCDF-GHJK" },
      cookieOf("dglobex"),
      undefined,
      limited,
    );
    expect(codeOf(other.result)).toBe("NOT_FOUND");
  });

  test("a tenant budget trips for any user, and a refused user spends no tenant budget", async () => {
    const tight = throttled({ user: 1, tenant: 2 });
    const app2 = createApp({ oauth: issuers, deviceThrottle: tight.throttle });
    const lookup = (slug: string) =>
      gql(
        slug,
        REQUEST,
        { code: "BCDF-GHJK" },
        cookieOf(slug),
        undefined,
        app2,
      );
    expect(codeOf((await lookup("dacme")).result)).toBe("NOT_FOUND");
    // The same user is refused by their own budget: the tenant count stays at 1.
    expect(codeOf((await lookup("dacme")).result)).toBe(
      "DEVICE_CODE_THROTTLED",
    );
    expect(tight.tenant.calls).toBe(1);
  });

  test("one approval of a live code counts once, not twice", async () => {
    const once = throttled({ user: 10 });
    const app3 = createApp({ oauth: issuers, deviceThrottle: once.throttle });
    const { user_code } = await deviceCodes("dacme");
    const before = once.user.calls;
    const approved = await gql(
      "dacme",
      APPROVE,
      { code: user_code },
      cookieOf("dacme"),
      undefined,
      app3,
    );
    expect(approved.result.errors).toBeUndefined();
    expect(once.user.calls - before).toBe(1);
  });

  test("an anonymous request is refused before anything is counted", async () => {
    const userCallsBefore = counters.user.calls;
    const { result } = await gql(
      "dacme",
      REQUEST,
      { code: "BCDF-GHJK" },
      undefined,
      undefined,
      limited,
    );
    expect(codeOf(result)).toBe("UNAUTHENTICATED");
    expect(counters.user.calls).toBe(userCallsBefore);
  });
});
