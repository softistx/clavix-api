import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createLocalJWKSet, decodeJwt, errors, type JSONWebKeySet } from "jose";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { registerStoredResource, resourcesService } from "@/config/resources";
import { permissionsFor, rolesFor, rolesService } from "@/config/roles";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { jsonOf } from "~/json";
import { defined } from "~/narrow";
import { recordBody } from "~/oauth-bodies";
import { createFlow } from "~/oauth-flow";
import {
  authorize,
  challenge,
  claimsOf,
  discover,
  handler,
  verifyAccessToken,
} from "../../docs/guide/examples/resource-server";

// The spec runs the code of docs/guide/resource-server.md against a real
// tenant issuer: the guide quotes docs/guide/examples/resource-server.ts.
const API = "https://api.guide.test/v1";
const SLUG = "guide-rs";
const SCOPES = ["invoices:read", "invoices:write", "invoices:delete"];
const flow = createFlow({ rolesFor, permissionsFor });
const trust = { issuer: flow.url(SLUG, ""), resource: API };
// The issuer answers in process: this stands in for the network.
const issuerFetch = (async (input: string | URL | Request) =>
  flow.get(SLUG, new URL(String(input)).pathname)) as typeof fetch;

let tenantId = new ObjectId();
let keys: ReturnType<typeof createLocalJWKSet>;
let token = "";

const resourceId = async () =>
  defined(
    (await resourcesService.listResources(tenantId)).find((r) => r.uri === API),
    API,
  );

beforeAll(async () => {
  tenantId = new ObjectId((await flow.setUp(SLUG, [])).tenantId);
  await registerStoredResource({ tenant: SLUG, uri: API, scopes: SCOPES });
  const resource = await resourceId();
  await resourcesService.updateResource(tenantId, resource._id.toHexString(), {
    enforceRbac: true,
  });
  const scopes = await resourcesService.listScopes(tenantId, {
    resourceId: resource._id,
  });
  // A role scoped to the Resource: read and write, not delete.
  const clerk = await rolesService.create(tenantId, {
    name: "clerk",
    resourceId: resource._id.toHexString(),
  });
  const id = clerk._id.toHexString();
  await rolesService.setPermissions(
    tenantId,
    id,
    scopes
      .filter((s) => s.name !== "invoices:delete")
      .map((s) => s._id.toHexString()),
  );
  await rolesService.assign(tenantId, id, "alice");
  // The user asks for all three scopes; the role holds two of them.
  const tokens = await flow.tokensOf(SLUG, SCOPES.join(" "), {
    resource: API,
    userId: "alice",
  });
  token = tokens.access_token ?? "";
  const { jwksUri } = await discover(trust.issuer, issuerFetch);
  keys = createLocalJWKSet(
    (await jsonOf(
      await issuerFetch(jwksUri),
      recordBody,
    )) as unknown as JSONWebKeySet,
  );
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.roles.raw.deleteMany({});
  await mongo.db.roleAssignments.raw.deleteMany({});
  await mongo.db.resources.raw.deleteMany({});
  await mongo.db.scopes.raw.deleteMany({});
  for (const name of ["oauthPartitionedClients", "oauthPartitionedGrants"]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

const call = (method: string, path: string) =>
  authorize({ method, path, token }, keys, trust);

describe("a resource server protected with Clavix tokens and limix", () => {
  test("the discovery names the issuer and its keys", async () => {
    const { jwksUri } = await discover(trust.issuer, issuerFetch);
    expect(jwksUri).toBe(flow.url(SLUG, "/jwks.json"));
  });

  test("the token verifies and maps to limix claims", async () => {
    const payload = await verifyAccessToken(token, keys, trust);
    expect(payload.sub).toBe("alice");
    const claims = claimsOf(payload);
    expect(claims).toMatchObject({
      authenticated: true,
      subject: { type: "user", id: "alice" },
      roles: ["clerk"],
      permissions: ["invoices:read", "invoices:write"],
    });
    expect(String(claims.scope).split(" ").sort()).toEqual(SCOPES.sort());
  });

  test("an allowed call: the permission is in scope and in permissions", async () => {
    expect(await call("GET", "/invoices")).toEqual({ allow: true });
    expect(await call("POST", "/invoices")).toEqual({ allow: true });
  });

  test("a refused call: in scope, but not in permissions", async () => {
    const decision = await call("DELETE", "/invoices/42");
    expect(decision).toMatchObject({
      allow: false,
      refusal: { code: "auth.errors.forbidden", status: 403 },
    });
  });

  test("a rule on roles reads the roles claim", async () => {
    const decision = await call("GET", "/reports");
    expect(decision).toMatchObject({ allow: false, refusal: { status: 403 } });
  });

  test("without a permissions claim the scope alone decides", () => {
    const claims = claimsOf({ sub: "bob", scope: "invoices:delete" });
    expect(claims).not.toHaveProperty("permissions");
  });

  test("another audience, a tampered token and a foreign issuer are refused", async () => {
    await expect(
      verifyAccessToken(token, keys, { ...trust, resource: `${API}/other` }),
    ).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
    await expect(
      verifyAccessToken(`${token}x`, keys, trust),
    ).rejects.toBeInstanceOf(errors.JWSSignatureVerificationFailed);
    await expect(
      verifyAccessToken(token, keys, {
        ...trust,
        issuer: "https://other.clavix.test",
      }),
    ).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
    expect(challenge("invalid_token")).toBe('Bearer error="invalid_token"');
  });

  test("the token is the Resource's: aud is its URI", () => {
    expect(decodeJwt(token).aud).toBe(API);
  });

  test("the HTTP edge answers 200, 401 and 403", async () => {
    const serve = handler(keys, trust);
    const url = "https://api.guide.test/invoices";
    const ask = (init: RequestInit & { token?: string } = {}) =>
      serve(
        new Request(url, {
          method: init.method ?? "GET",
          headers:
            init.token === undefined
              ? {}
              : { authorization: `Bearer ${init.token}` },
        }),
      );
    expect((await ask({ token })).status).toBe(200);
    const anonymous = await ask();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe(
      'Bearer realm="api"',
    );
    const forged = await ask({ token: `${token}x` });
    expect(forged.status).toBe(401);
    expect(forged.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"',
    );
    const refused = await serve(
      new Request(url, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: "auth.errors.forbidden" });
  });

  test("every ts block of the guide marked as an example is the example's code", () => {
    const source = readFileSync(
      "docs/guide/examples/resource-server.ts",
      "utf8",
    );
    const guide = readFileSync("docs/guide/resource-server.md", "utf8");
    const marker = "// docs/guide/examples/resource-server.ts\n";
    const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)]
      .map((match) => match[1] ?? "")
      .filter((block) => block.startsWith(marker));
    expect(blocks.length).toBeGreaterThan(3);
    for (const block of blocks) {
      expect(source).toContain(block.slice(marker.length).trimEnd());
    }
  });
});
