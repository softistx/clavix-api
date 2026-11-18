import { beforeAll, describe, expect, test } from "bun:test";
import { protectedResource, s256Challenge } from "@softistx/janus-oauth";
import { ObjectId } from "mongodb";
import { agentClientsService } from "@/config/agent-clients";
import { clientsService } from "@/config/clients";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantAdmin, tenantResolver, tenantsService } from "@/config/tenancy";
import type { AgentsPolicy } from "@/modules/oauth-policy/oauth-policy.schema";
import { partitionOf } from "@/modules/tenants/identity";
import { createFlow, DOMAIN } from "~/oauth-flow";
import { createRegisterRoute } from "./register-route";
import { RegisterThrottledError } from "./register-throttle";

const CALLBACK = "https://app.example/callback";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const DOC_URL = "https://app.example/oauth/client.json";
const VERIFIER = "a".repeat(64);

let hits = 0;
const flow = createFlow({
  registerThrottle: {
    async check() {
      // Only the "agents-throttled" tenant counts: three registrations pass.
      if (!throttled) return;
      hits += 1;
      if (hits > 3) throw new RegisterThrottledError(42);
    },
  },
  metadataTransport: {
    resolve: async () => ["93.184.216.34"],
    fetch: async () =>
      Response.json({
        client_id: DOC_URL,
        client_name: "Doc agent",
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "none",
      }),
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
  if (found == null) throw new Error(`no tenant ${slug}`);
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
    "ag-suspended",
    "ag-docs",
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
  await setAgents("ag-suspended", { dynamic: "open" });
  await setAgents("ag-mcp", { dynamic: "restricted" });
  await setAgents("ag-docs", {
    metadataDocuments: true,
    allowHosts: ["app.example"],
  });
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

  test("the device URN and the token exchange URN are refused", async () => {
    for (const grant of [
      "urn:ietf:params:oauth:grant-type:device_code",
      "urn:ietf:params:oauth:grant-type:token-exchange",
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
        ((await (last as Response).json()) as { error: string }).error,
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
    if (found == null) throw new Error("no tenant");
    await tenantAdmin.setPlan(found._id, {
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

describe("suspended tenant", () => {
  test("403 TENANT_SUSPENDED, and nothing stored", async () => {
    const found = await mongo.db.tenants.findFirst({ slug: "ag-suspended" });
    if (found == null) throw new Error("no tenant");
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
    const { client_id } = (await response.json()) as { client_id: string };
    const a = await tenantResolver.resolveHost(`ag-open.${DOMAIN}`);
    const b = await tenantResolver.resolveHost(`ag-off.${DOMAIN}`);
    if (a === null || b === null) throw new Error("no tenant");
    expect(await agentClientsService.has(a.tenantId, client_id)).toBe(true);
    expect(await agentClientsService.has(b.tenantId, client_id)).toBe(false);
    const doc = await mongo.db.tenants.findFirst({ slug: "ag-open" });
    if (doc == null) throw new Error("no tenant");
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
    expect(((await response.json()) as { error: string }).error).toBe(
      "invalid_client_metadata",
    );
  });
});
