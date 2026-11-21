import { beforeAll, describe, expect, test } from "bun:test";
import { protectedResource, s256Challenge } from "@softistx/janus-oauth";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { agentClientsService } from "@/config/agent-clients";
import { clientsService } from "@/config/clients";
import { mongo } from "@/config/db";
import { noThrottle } from "@/config/no-ops";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import type { AgentsPolicy } from "@/modules/oauth-policy";
import { partitionOf } from "@/modules/tenants";
import { errorBody, jsonOf } from "~/json";
import { defined } from "~/narrow";
import { createFlow, DOMAIN } from "~/oauth-flow";
import { createRegisterRoute } from "./register-route";
import {
  MetadataThrottledError,
  RegisterThrottledError,
} from "./register-throttle";

const CALLBACK = "https://app.example/callback";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const DOC_URL = "https://app.example/oauth/client.json";
const VERIFIER = "a".repeat(64);

let hits = 0;
let metadataHits = 0;
let metadataThrottled = false;
let fetched = 0;
const flow = createFlow({
  registerThrottle: {
    async check() {
      // Only the "agents-throttled" tenant counts: three registrations pass.
      if (!throttled) return;
      hits += 1;
      if (hits > 3) throw new RegisterThrottledError(42);
    },
  },
  metadataThrottle: {
    async check() {
      if (!metadataThrottled) return;
      metadataHits += 1;
      if (metadataHits > 2) throw new MetadataThrottledError(17);
    },
  },
  metadataTransport: {
    resolve: async () => ["93.184.216.34"],
    fetch: async () => {
      fetched += 1;
      return Response.json({
        client_id: DOC_URL,
        client_name: "Doc agent",
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "none",
      });
    },
  },
});
let throttled = false;

const policy = (agents: Partial<AgentsPolicy>) => ({
  dynamic: "off" as const,
  redirectUris: [],
  metadataDocuments: false,
  allowHosts: [],
  ...agents,
});

async function setAgents(slug: string, agents: Partial<AgentsPolicy>) {
  const found = await mongo.db.tenants.findFirst({ slug });
  if (found === null || found === undefined)
    throw new Error(`no tenant ${slug}`);
  await tenantsService.updateOAuth(found._id, (tenant) => ({
    ...tenant.oauth,
    agents: policy(agents),
  }));
}

const register = (slug: string, body: unknown, ip?: string) =>
  flow.issuers.register(
    new Request(flow.url(slug, "/register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ip,
  );

const metadata = { client_name: "Agent", token_endpoint_auth_method: "none" };

const countOf = async (slug: string, kind?: "dynamic" | "metadata") => {
  const t = await tenantResolver.resolveHost(`${slug}.${DOMAIN}`);
  return agentClientsService.count(t?.tenantId ?? "", kind);
};

beforeAll(async () => {
  for (const slug of [
    "ag-off",
    "ag-restricted",
    "ag-open",
    "ag-throttled",
    "ag-quota",
    "ag-quota-other",
    "ag-race",
    "ag-docs-race",
    "ag-suspended",
    "ag-docs",
    "ag-docs-throttled",
    "ag-docs-quota",
    "ag-mcp",
  ]) {
    await flow.setUp(
      slug,
      slug === "ag-mcp" ? ["https://api.example/mcp"] : [],
    );
  }
  await setAgents("ag-restricted", { dynamic: "restricted" });
  await setAgents("ag-open", { dynamic: "open" });
  await setAgents("ag-throttled", { dynamic: "open" });
  await setAgents("ag-quota", { dynamic: "open" });
  await setAgents("ag-quota-other", { dynamic: "open" });
  await setAgents("ag-race", { dynamic: "open" });
  await setAgents("ag-docs-race", {
    metadataDocuments: true,
    allowHosts: ["app.example"],
  });
  await setAgents("ag-suspended", { dynamic: "open" });
  await setAgents("ag-mcp", { dynamic: "restricted" });
  for (const slug of ["ag-docs", "ag-docs-throttled", "ag-docs-quota"]) {
    await setAgents(slug, {
      metadataDocuments: true,
      allowHosts: ["app.example"],
    });
  }
});

describe("policy off (the default)", () => {
  test("/register answers 400 invalid_request and the discovery has no registration_endpoint", async () => {
    const response = await register("ag-off", {
      ...metadata,
      redirect_uris: [CALLBACK],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_request");
    const discovery = await flow.get(
      "ag-off",
      "/.well-known/oauth-authorization-server",
    );
    const body = await discovery.json();
    expect(body.registration_endpoint).toBeUndefined();
    expect(body.client_id_metadata_document_supported).toBeFalsy();
    expect(await countOf("ag-off")).toBe(0);
  });

  test("the handle path and a GET both refuse", async () => {
    const viaHandle = await flow.issuers.handle(
      new Request(flow.url("ag-off", "/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...metadata, redirect_uris: [CALLBACK] }),
      }),
    );
    expect(viaHandle.status).toBe(400);
    const get = await flow.issuers.register(
      new Request(flow.url("ag-off", "/register")),
      undefined,
    );
    expect(get.status).toBe(405);
  });
});

describe("restricted", () => {
  test("refuses a foreign callback, accepts an MCP client's and a loopback one", async () => {
    const foreign = await register("ag-restricted", {
      ...metadata,
      redirect_uris: ["https://evil.example/cb"],
    });
    expect(foreign.status).toBe(400);
    expect((await foreign.json()).error).toBe("invalid_redirect_uri");
    expect(await countOf("ag-restricted")).toBe(0);

    const claude = await register("ag-restricted", {
      ...metadata,
      redirect_uris: [CLAUDE_CALLBACK],
    });
    expect(claude.status).toBe(201);
    expect(claude.headers.get("cache-control")).toBe("no-store");
    const registered = await claude.json();
    expect(registered.client_id).toBeString();
    expect(registered.client_secret).toBeUndefined();

    const loopback = await register("ag-restricted", {
      ...metadata,
      redirect_uris: ["http://127.0.0.1:51234/callback"],
    });
    expect(loopback.status).toBe(201);
    expect(await countOf("ag-restricted", "dynamic")).toBe(2);
  });

  test("a redirect URI the tenant listed is accepted", async () => {
    await setAgents("ag-restricted", {
      dynamic: "restricted",
      redirectUris: [CALLBACK],
    });
    const response = await register("ag-restricted", {
      ...metadata,
      redirect_uris: [CALLBACK],
    });
    expect(response.status).toBe(201);
  });
});

describe("open", () => {
  test("registers any valid redirect URI and records an agent", async () => {
    const response = await register("ag-open", {
      ...metadata,
      redirect_uris: [CALLBACK],
    });
    expect(response.status).toBe(201);
    const client = await response.json();
    expect(
      await agentClientsService.has(
        (await tenantResolver.resolveHost(`ag-open.${DOMAIN}`))?.tenantId ?? "",
        client.client_id,
      ),
    ).toBe(true);
  });

  test("the device URN and the token exchange URN, and client_credentials, are refused", async () => {
    for (const grant of [
      "urn:ietf:params:oauth:grant-type:device_code",
      "urn:ietf:params:oauth:grant-type:token-exchange",
      "client_credentials",
    ]) {
      const response = await register("ag-open", {
        ...metadata,
        redirect_uris: [CALLBACK],
        grant_types: ["authorization_code", grant],
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_client_metadata");
    }
  });

  test("a body that is not an object is invalid_client_metadata", async () => {
    const response = await register("ag-open", "nope");
    expect(response.status).toBe(400);
  });
});

describe("throttle", () => {
  test("answers 429 with Retry-After once past the limit", async () => {
    throttled = true;
    hits = 0;
    try {
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < 5; i++) {
        last = await register(
          "ag-throttled",
          { ...metadata, redirect_uris: [CALLBACK] },
          "203.0.113.9",
        );
        statuses.push(last.status);
      }
      expect(statuses).toEqual([201, 201, 201, 429, 429]);
      expect(last?.headers.get("retry-after")).toBe("42");
      expect(
        (await jsonOf(defined(last, "the last response"), errorBody)).error,
      ).toBe("temporarily_unavailable");
      expect(await countOf("ag-throttled")).toBe(3);
    } finally {
      throttled = false;
    }
  });
});

describe("agents quota", () => {
  test("403 access_denied once the tenant's quota is reached, other tenants unaffected", async () => {
    const found = await mongo.db.tenants.findFirst({ slug: "ag-quota" });
    if (found === null || found === undefined) throw new Error("no tenant");
    await tenantsService.setPlan(found._id, {
      plan: "free",
      quotaOverrides: { agents: 2 },
    });
    const body = { ...metadata, redirect_uris: [CALLBACK] };
    expect((await register("ag-quota", body)).status).toBe(201);
    expect((await register("ag-quota", body)).status).toBe(201);
    const refused = await register("ag-quota", body);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe("access_denied");
    expect(await countOf("ag-quota")).toBe(2);
    // Another tenant's agents are not counted.
    expect(await countOf("ag-quota-other")).toBe(0);
    expect((await register("ag-quota-other", body)).status).toBe(201);
  });
});

describe("agents quota under concurrency", () => {
  test("at most N of many simultaneous registrations pass a quota of N", async () => {
    const found = await mongo.db.tenants.findFirst({ slug: "ag-race" });
    if (found === null || found === undefined) throw new Error("no tenant");
    await tenantsService.setPlan(found._id, {
      plan: "free",
      quotaOverrides: { agents: 3 },
    });
    const body = { ...metadata, redirect_uris: [CALLBACK] };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => register("ag-race", body)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 403)).toHaveLength(7);
    expect(await countOf("ag-race")).toBe(3);
  });
});

describe("suspended tenant", () => {
  test("403 TENANT_SUSPENDED, and nothing stored", async () => {
    const found = await mongo.db.tenants.findFirst({ slug: "ag-suspended" });
    if (found === null || found === undefined) throw new Error("no tenant");
    await tenantsService.suspend(found._id);
    const response = await register("ag-suspended", {
      ...metadata,
      redirect_uris: [CALLBACK],
    });
    expect(response.status).toBe(403);
    expect(await countOf("ag-suspended")).toBe(0);
  });
});

describe("discovery", () => {
  test("shows registration_endpoint and client_id_metadata_document_supported", async () => {
    const dynamic = await (
      await flow.get("ag-open", "/.well-known/oauth-authorization-server")
    ).json();
    expect(dynamic.registration_endpoint).toBe(
      flow.url("ag-open", "/register"),
    );
    const docs = await (
      await flow.get("ag-docs", "/.well-known/oauth-authorization-server")
    ).json();
    expect(docs.client_id_metadata_document_supported).toBe(true);
    expect(docs.registration_endpoint).toBeUndefined();
  });
});

describe("metadata documents", () => {
  test("a client is recorded as an agent on its first use, once", async () => {
    const authorize = () =>
      flow.get(
        "ag-docs",
        `/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: DOC_URL,
          redirect_uri: CALLBACK,
          code_challenge: "x".repeat(43),
          code_challenge_method: "S256",
          scope: "openid",
          state: "s",
        })}`,
      );
    expect((await authorize()).status).toBe(302);
    expect(await countOf("ag-docs", "metadata")).toBe(1);
    await authorize();
    expect(await countOf("ag-docs", "metadata")).toBe(1);
  });
});

describe("a full MCP flow", () => {
  test("401 challenge, registration, then code + PKCE", async () => {
    const slug = "ag-mcp";
    const resource = "https://api.example/mcp";
    const mcp = protectedResource({
      resource,
      issuer: flow.url(slug, ""),
      scopes: ["read"],
    });
    // 1. The resource server answers 401 and points to its metadata.
    const challenge = mcp.challenge();
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
    // 2. The client registers.
    const registered = await register(slug, {
      ...metadata,
      redirect_uris: [CLAUDE_CALLBACK],
    });
    expect(registered.status).toBe(201);
    const { client_id } = await registered.json();
    // 3. authorize with PKCE, approve, exchange the code.
    const authorize = await flow.get(
      slug,
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: await s256Challenge(VERIFIER),
        code_challenge_method: "S256",
        scope: "read",
        resource,
        state: "xyz",
      })}`,
    );
    expect(authorize.status).toBe(302);
    const consent = new URL(
      authorize.headers.get("location") ?? "",
      flow.url(slug, "/"),
    );
    const server = await flow.issuers.serverFor(
      new Request(flow.url(slug, "/")),
    );
    if (server === null) throw new Error("no server");
    const { redirectTo } = await server.approve(
      { id: "user-mcp" },
      consent.searchParams.get("request_id") ?? "",
      { scopes: ["read"], authTime: new Date() },
    );
    const code = new URL(redirectTo).searchParams.get("code") ?? "";
    const token = await flow.post(slug, "/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: VERIFIER,
      client_id,
      resource,
    });
    expect(token.status).toBe(200);
    expect((await token.json()).access_token).toBeString();
  });
});

describe("agent records", () => {
  test("deleting a client frees its agent record, and an agent of A is unknown to B", async () => {
    const response = await register("ag-open", {
      ...metadata,
      redirect_uris: [CALLBACK],
    });
    const { client_id } = await jsonOf(
      response,
      z.looseObject({ client_id: z.string() }),
    );
    const a = await tenantResolver.resolveHost(`ag-open.${DOMAIN}`);
    const b = await tenantResolver.resolveHost(`ag-off.${DOMAIN}`);
    if (a === null || b === null) throw new Error("no tenant");
    expect(await agentClientsService.has(a.tenantId, client_id)).toBe(true);
    expect(await agentClientsService.has(b.tenantId, client_id)).toBe(false);
    const doc = await mongo.db.tenants.findFirst({ slug: "ag-open" });
    if (doc === null || doc === undefined) throw new Error("no tenant");
    const before = await agentClientsService.count(a.tenantId);
    await clientsService.delete(doc, client_id);
    expect(await agentClientsService.has(a.tenantId, client_id)).toBe(false);
    expect(await agentClientsService.count(a.tenantId)).toBe(before - 1);
  });

  test("a record that fails to write takes the registered client back", async () => {
    const tenant = await tenantResolver.resolveHost(`ag-open.${DOMAIN}`);
    if (tenant === null) throw new Error("no tenant");
    const clients = () =>
      oauthDb.collection("oauthPartitionedClients").countDocuments({
        partition: partitionOf(new ObjectId(tenant.tenantId)),
      });
    const route = createRegisterRoute({
      resolver: tenantResolver,
      serverFor: flow.issuers.serverFor,
      throttle: noThrottle,
      agents: {
        ...agentClientsService,
        count: async () => 0,
        record: async () => {
          throw new Error("disk full");
        },
        has: async () => false,
        remove: async () => {},
      },
      agentQuotaOf: async () => null,
      exclusive: (_key, work) => work(),
      log: () => {},
    });
    const before = await clients();
    await expect(
      route(
        new Request(flow.url("ag-open", "/register"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...metadata, redirect_uris: [CALLBACK] }),
        }),
        undefined,
      ),
    ).rejects.toThrow("disk full");
    expect(await clients()).toBe(before);
  });

  test("a body over 16 KiB is refused", async () => {
    const response = await register("ag-open", {
      ...metadata,
      redirect_uris: [CALLBACK],
      software_id: "x".repeat(17 * 1024),
    });
    expect(response.status).toBe(400);
    expect((await jsonOf(response, errorBody)).error).toBe(
      "invalid_client_metadata",
    );
  });
});

describe("the registration body is bounded", () => {
  const post = (init: RequestInit & { duplex?: "half" }) =>
    flow.issuers.register(
      new Request(flow.url("ag-open", "/register"), {
        method: "POST",
        headers: { "content-type": "application/json", ...init.headers },
        ...init,
      }),
      undefined,
    );

  test("a Content-Length over 16 KiB is 413 before the body is read", async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const before = await countOf("ag-open");
    const response = await post({
      body,
      duplex: "half",
      headers: { "content-length": String(17 * 1024) },
    });
    expect(response.status).toBe(413);
    expect(await countOf("ag-open")).toBe(before);
  });

  test("with no Content-Length the stream is cut at 16 KiB, never buffered whole", async () => {
    let sent = 0;
    const chunk = new Uint8Array(4 * 1024).fill(32);
    const body = new ReadableStream({
      pull(controller) {
        sent += 1;
        if (sent > 1000) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const before = await countOf("ag-open");
    const response = await post({ body, duplex: "half" });
    expect(response.status).toBe(400);
    expect((await jsonOf(response, errorBody)).error).toBe(
      "invalid_client_metadata",
    );
    // The cap is 16 KiB: a handful of 4 KiB chunks, not the whole stream.
    expect(sent).toBeLessThan(20);
    expect(await countOf("ag-open")).toBe(before);
  });
});

describe("metadata documents: abuse limits", () => {
  const authorize = (slug: string) =>
    flow.get(
      slug,
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: DOC_URL,
        redirect_uri: CALLBACK,
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
        scope: "openid",
        state: "s",
      })}`,
    );

  test("the fetch is throttled: 429 with Retry-After, and no document is fetched past the limit", async () => {
    metadataThrottled = true;
    metadataHits = 0;
    fetched = 0;
    try {
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < 4; i++) {
        last = await authorize("ag-docs-throttled");
        statuses.push(last.status);
      }
      expect(statuses).toEqual([302, 302, 429, 429]);
      expect(last?.headers.get("retry-after")).toBe("17");
      expect(
        (await jsonOf(defined(last, "the last response"), errorBody)).error,
      ).toBe("temporarily_unavailable");
      // The cache serves the second request: one fetch, none once throttled.
      expect(fetched).toBeLessThanOrEqual(2);
    } finally {
      metadataThrottled = false;
    }
  });

  test("a pushed request is throttled too", async () => {
    metadataThrottled = true;
    metadataHits = 10;
    try {
      const response = await flow.post("ag-docs-throttled", "/par", {
        response_type: "code",
        client_id: DOC_URL,
        redirect_uri: CALLBACK,
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
      });
      expect(response.status).toBe(429);
    } finally {
      metadataThrottled = false;
    }
  });

  test("past the agents quota a new metadata client is refused 403 before any fetch, a known one is not", async () => {
    const found = await mongo.db.tenants.findFirst({ slug: "ag-docs-quota" });
    const tenant = await tenantResolver.resolveHost(`ag-docs-quota.${DOMAIN}`);
    if (found === null || found === undefined || tenant === null)
      throw new Error("no tenant");
    await tenantsService.setPlan(found._id, {
      plan: "free",
      quotaOverrides: { agents: 1 },
    });
    await agentClientsService.record(tenant.tenantId, {
      clientId: "someone-else",
      kind: "dynamic",
    });
    fetched = 0;
    const refused = await authorize("ag-docs-quota");
    expect(refused.status).toBe(403);
    expect((await jsonOf(refused, errorBody)).error).toBe("access_denied");
    expect(fetched).toBe(0);
    expect(await countOf("ag-docs-quota", "metadata")).toBe(0);
    // A client already recorded keeps working over the quota.
    await agentClientsService.record(tenant.tenantId, {
      clientId: DOC_URL,
      kind: "metadata",
    });
    expect((await authorize("ag-docs-quota")).status).toBe(302);
  });

  test("simultaneous first uses of one new client under a quota of 1 all pass and record it once", async () => {
    const found = await mongo.db.tenants.findFirst({ slug: "ag-docs-race" });
    if (found === null || found === undefined) throw new Error("no tenant");
    await tenantsService.setPlan(found._id, {
      plan: "free",
      quotaOverrides: { agents: 1 },
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => authorize("ag-docs-race")),
    );
    expect(results.map((r) => r.status)).toEqual([302, 302, 302, 302, 302]);
    expect(await countOf("ag-docs-race", "metadata")).toBe(1);
  });
});
