import { beforeAll, describe, expect, test } from "bun:test";
import { CLIENT_CREDENTIALS_GRANT } from "@softistx/janus-oauth";
import { decodeJwt } from "jose";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { catalog, registerStoredResource } from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { createConsoleAuthenticator } from "@/console/auth";
import { registerClient } from "@/modules/clients/register-client";
import { createFlow } from "~/oauth-flow";
import { withTenantState } from "./tenant-state";

const OPEN = "https://machine.cc.example/api";
const CLOSED = "https://closed.cc.example/api";
const SLUG = "cc-a";
const flow = createFlow();
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });

interface Answer {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string | null;
  id_token?: string | null;
  error?: string;
}

const secrets: Record<string, string> = {};
let tenantId = new ObjectId();

/** Registers a client of `SLUG` with the grant (confidential unless said) and remembers its secret. */
async function machine(
  clientId: string,
  options: {
    type?: "public" | "confidential";
    slug?: string;
    allowedScopes?: string[];
    defaultScopes?: string[];
  } = {},
) {
  const registered = await registerClient(
    { db: oauthDb, findTenant },
    {
      tenant: options.slug ?? SLUG,
      name: clientId,
      clientId,
      redirectUris: [],
      type: options.type ?? "confidential",
      grants: [CLIENT_CREDENTIALS_GRANT],
      allowedScopes: options.allowedScopes ?? ["read", "write"],
      ...(options.defaultScopes === undefined
        ? {}
        : { defaultScopes: options.defaultScopes }),
    },
  );
  secrets[clientId] = registered.clientSecret ?? "";
}

const token = (
  clientId: string,
  body: Record<string, string> = { resource: OPEN },
  slug = SLUG,
) =>
  flow.post(
    slug,
    "/token",
    { grant_type: CLIENT_CREDENTIALS_GRANT, ...body },
    flow.basic(clientId, secrets[clientId] ?? ""),
  );

const answerOf = async (response: Response) =>
  (await response.json()) as Answer;

beforeAll(async () => {
  const { tenantId: id } = await flow.setUp(SLUG);
  tenantId = new ObjectId(String(id));
  await registerStoredResource({
    tenant: SLUG,
    uri: OPEN,
    scopes: ["read", "write", "admin"],
  });
  await registerStoredResource({ tenant: SLUG, uri: CLOSED, scopes: ["read"] });
  const [open] = (await catalog.listResources(tenantId)).filter(
    (resource) => resource.uri === OPEN,
  );
  if (open === undefined) throw new Error("resource not stored");
  await catalog.updateResource(tenantId, open._id.toHexString(), {
    allowClientCredentials: true,
  });
  await machine("worker", { defaultScopes: ["read"] });
  await machine("narrow", { allowedScopes: ["read"] });
});

describe("the client credentials grant", () => {
  test("a confidential client gets a token of its own for an opted-in resource", async () => {
    const response = await token("worker", { resource: OPEN, scope: "read" });
    expect(response.status).toBe(200);
    const body = await answerOf(response);
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("read");
    // A machine has no refresh token and no ID token.
    expect(body.refresh_token ?? null).toBeNull();
    expect(body.id_token ?? null).toBeNull();
    const claims = decodeJwt(body.access_token ?? "");
    expect(claims["sub"]).toBe("worker");
    expect(claims["client_id"]).toBe("worker");
    expect(claims["aud"]).toBe(OPEN);
    // No user, so no roles claim to look up.
    expect(claims["roles"]).toBeUndefined();
  });

  test("a request with no scope gets the client's default scopes", async () => {
    const body = await answerOf(await token("worker"));
    expect(body.scope).toBe("read");
  });

  test("the token is cut to the client's allowed scopes", async () => {
    const body = await answerOf(
      await token("narrow", { resource: OPEN, scope: "read write" }),
    );
    expect(body.scope).toBe("read");
    // Nothing allowed is left: refused, not an empty token.
    const refused = await token("narrow", { resource: OPEN, scope: "admin" });
    expect(refused.status).toBe(400);
    expect((await answerOf(refused)).error).toBe("invalid_scope");
  });

  test("a resource that has not opted in is refused", async () => {
    const response = await token("worker", { resource: CLOSED, scope: "read" });
    expect(response.status).toBe(400);
    expect((await answerOf(response)).error).toBe("invalid_target");
  });

  test("no resource is refused too: the default (userinfo) never opts in", async () => {
    const response = await token("worker", { scope: "read" });
    expect(response.status).toBe(400);
    expect((await answerOf(response)).error).toBe("invalid_target");
  });

  test("a public client cannot be registered with the grant, and is refused if one is forced in", async () => {
    await expect(machine("open-client", { type: "public" })).rejects.toThrow(
      /needs a confidential client/,
    );
    // Even a record written by hand is refused at the token endpoint.
    const store = (
      await import("@softistx/janus-oauth-mongo")
    ).createMongoOAuth(oauthDb, {
      partition: (await import("@/modules/tenants")).partitionOf(tenantId),
    });
    await store.upsertClient({
      id: "forced-public",
      name: "forced",
      redirectUris: [],
      source: "registered",
      createdAt: new Date(),
      expiresAt: null,
      grantTypes: [CLIENT_CREDENTIALS_GRANT],
      allowedScopes: ["read"],
    });
    const response = await flow.post(
      SLUG,
      "/token",
      { grant_type: CLIENT_CREDENTIALS_GRANT, resource: OPEN, scope: "read" },
      flow.basic("forced-public", ""),
    );
    expect(response.status).toBe(401);
    expect((await answerOf(response)).error).toBe("invalid_client");
  });

  test("a client that does not list the grant is refused", async () => {
    const response = await flow.post(
      SLUG,
      "/token",
      { grant_type: CLIENT_CREDENTIALS_GRANT, resource: OPEN, scope: "read" },
      flow.basic("backend", flow.clients[SLUG]?.secret ?? ""),
    );
    expect((await answerOf(response)).error).toBe("unauthorized_client");
  });

  test("a client with the grant needs allowed scopes, and defaults within them", async () => {
    await expect(
      registerClient(
        { db: oauthDb, findTenant },
        {
          tenant: SLUG,
          name: "none",
          clientId: "none",
          redirectUris: [],
          type: "confidential",
          grants: [CLIENT_CREDENTIALS_GRANT],
        },
      ),
    ).rejects.toThrow(/at least one allowed scope/);
    await expect(
      machine("outside", { allowedScopes: ["read"], defaultScopes: ["write"] }),
    ).rejects.toThrow(/default scopes must be allowed scopes/);
  });

  test("scopes belong to the grant: they go with it", async () => {
    await expect(
      registerClient(
        { db: oauthDb, findTenant },
        {
          tenant: SLUG,
          name: "code",
          clientId: "code-client",
          redirectUris: ["https://app.example/callback"],
          type: "confidential",
          allowedScopes: ["read"],
        },
      ),
    ).rejects.toThrow(/belong to the client_credentials grant/);
  });

  test("turning the resource's opt-in off refuses new tokens at once", async () => {
    const [closing] = (await catalog.listResources(tenantId)).filter(
      (resource) => resource.uri === OPEN,
    );
    if (closing === undefined) throw new Error("resource not stored");
    await catalog.updateResource(tenantId, closing._id.toHexString(), {
      allowClientCredentials: false,
    });
    const off = await token("worker", { resource: OPEN, scope: "read" });
    expect(off.status).toBe(400);
    // With no resource left that opted in, the grant is off for the tenant.
    expect((await answerOf(off)).error).toBe("unsupported_grant_type");
    await catalog.updateResource(tenantId, closing._id.toHexString(), {
      allowClientCredentials: true,
    });
    expect((await token("worker", { scope: "read" })).status).toBe(400);
    expect(
      (await token("worker", { resource: OPEN, scope: "read" })).status,
    ).toBe(200);
  });

  test("another tenant that never opted in stays off", async () => {
    await flow.setUp("cc-other");
    await registerStoredResource({
      tenant: "cc-other",
      uri: OPEN,
      scopes: ["read"],
    });
    await machine("other-worker", {
      slug: "cc-other",
      allowedScopes: ["read"],
    });
    const refused = await token(
      "other-worker",
      { resource: OPEN, scope: "read" },
      "cc-other",
    );
    expect(refused.status).toBe(400);
    expect((await answerOf(refused)).error).toBe("unsupported_grant_type");
    expect(
      (await token("worker", { resource: OPEN, scope: "read" })).status,
    ).toBe(200);
  });

  test("a client's credentials posted to another tenant's host are 401 invalid_client", async () => {
    const { tenantId: other } = await flow.setUp("cc-b");
    // Opted in on B too, so the refusal is the client's, not the grant's.
    await registerStoredResource({
      tenant: "cc-b",
      uri: OPEN,
      scopes: ["read"],
    });
    const [stored] = (
      await catalog.listResources(new ObjectId(String(other)))
    ).filter((resource) => resource.uri === OPEN);
    if (stored === undefined) throw new Error("resource not stored");
    await catalog.updateResource(
      new ObjectId(String(other)),
      stored._id.toHexString(),
      {
        allowClientCredentials: true,
      },
    );
    const crossed = await token(
      "worker",
      { resource: OPEN, scope: "read" },
      "cc-b",
    );
    expect(crossed.status).toBe(401);
    expect((await answerOf(crossed)).error).toBe("invalid_client");
  });

  test("another tenant's client is refused on a resource that opted in elsewhere", async () => {
    await flow.setUp("cc-c");
    await machine("c-worker", { slug: "cc-c", allowedScopes: ["read"] });
    // OPEN opted in for cc-a only; cc-c has no such resource.
    const refused = await token(
      "c-worker",
      { resource: OPEN, scope: "read" },
      "cc-c",
    );
    expect(refused.status).toBe(400);
    expect(["unsupported_grant_type", "invalid_target"]).toContain(
      (await answerOf(refused)).error ?? "",
    );
  });

  test("a suspended tenant's client_credentials /token is refused", async () => {
    await flow.setUp("cc-susp");
    await machine("s-worker", { slug: "cc-susp", allowedScopes: ["read"] });
    const tenant = await findTenant("cc-susp");
    if (tenant === undefined) throw new Error("no tenant");
    await tenantsService.suspend(tenant._id.toHexString());
    const guarded = withTenantState(flow.issuers, { resolver: tenantResolver });
    const response = await guarded.handle(
      new Request(flow.url("cc-susp", "/token"), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: flow.basic("s-worker", secrets["s-worker"] ?? ""),
        },
        body: new URLSearchParams({
          grant_type: CLIENT_CREDENTIALS_GRANT,
          resource: OPEN,
          scope: "read",
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "TENANT_SUSPENDED" });
  });

  test("a client_credentials token records no active user", async () => {
    const active: string[] = [];
    const guarded = withTenantState(flow.issuers, {
      resolver: tenantResolver,
      onActive: (tenantIdOf, userId) => {
        active.push(`${tenantIdOf}/${userId}`);
      },
    });
    const response = await guarded.handle(
      new Request(flow.url(SLUG, "/token"), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: flow.basic("worker", secrets["worker"] ?? ""),
        },
        body: new URLSearchParams({
          grant_type: CLIENT_CREDENTIALS_GRANT,
          resource: OPEN,
          scope: "read",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(active).toEqual([]);
  });
});

describe("what a client-only token can reach", () => {
  const issued = async () =>
    (await answerOf(await token("worker", { resource: OPEN, scope: "read" })))
      .access_token ?? "";

  test("userinfo answers 401 invalid_token", async () => {
    const response = await flow.get(
      SLUG,
      "/userinfo",
      `Bearer ${await issued()}`,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate") ?? "").toContain(
      "invalid_token",
    );
  });

  test("the API refuses it unless it opts in", async () => {
    const server = await flow.issuers.serverFor(
      new Request(flow.url(SLUG, "/")),
    );
    if (server === null) throw new Error("no server");
    const headers = new Headers({ authorization: `Bearer ${await issued()}` });
    const request = { headers, method: "GET", url: "https://api.example/" };
    // Not opted in: the default of every reader of a bearer principal.
    const refused = await server.authenticateRequest(request, {
      resource: OPEN,
    });
    expect("refused" in refused).toBe(true);
    // Opted in, the principal is the client's, with no user.
    const accepted = await server.authenticateRequest(request, {
      resource: OPEN,
      clientCredentials: true,
    });
    expect("ok" in accepted && accepted.ok?.subjectType).toBe("client");
  });

  test("the console never takes it", async () => {
    const server = await flow.issuers.serverFor(
      new Request(flow.url(SLUG, "/")),
    );
    const authenticate = createConsoleAuthenticator({
      audience: OPEN,
      publicUrl: "https://console.example/console/graphql",
      serverOfClavix: async () => server,
    });
    const request = new Request("https://console.example/console/graphql", {
      headers: { authorization: `Bearer ${await issued()}` },
    });
    expect(await authenticate(request)).toBeNull();
  });
});
