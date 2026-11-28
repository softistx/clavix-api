import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLIENT_CREDENTIALS_GRANT } from "@softistx/janus-oauth";
import { decodeJwt, decodeProtectedHeader, errors } from "jose";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { noDetailTypes } from "@/config/no-ops";
import { oauthDb } from "@/config/oauth-db";
import { registerStoredResource, resourcesService } from "@/config/resources";
import { permissionsFor, rolesFor, rolesService } from "@/config/roles";
import { registerClient } from "@/modules/clients";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { jsonOf } from "~/json";
import { defined } from "~/narrow";
import { answerBody } from "~/oauth-bodies";
import { createFlow } from "~/oauth-flow";
import {
  access,
  authorize,
  authorizeOwned,
  challenge,
  claimsOf,
  discover,
  handler,
  modelIssues,
  remoteKeys,
  verifyAccessToken,
} from "../../docs/guide/examples/resource-server";

// The guide's code against the in-process issuer on real Mongo.
const API = "https://api.guide.test/v1";
const SLUG = "guide-rs";
const SCOPES = ["invoices:read", "invoices:write", "invoices:delete"];
const flow = createFlow({ rolesFor, permissionsFor });
const trust = { issuer: flow.url(SLUG, ""), resource: API };
const issuerFetch = (url: string) => flow.get(SLUG, new URL(url).pathname);

let tenantId = new ObjectId();
let keys = remoteKeys("https://unset.test/jwks.json");
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
    allowClientCredentials: true,
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
  // jose fetches the issuer's JWKS itself, through the in-process issuer.
  keys = remoteKeys(jwksUri, issuerFetch);
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

  test("the token is the Resource's: aud is its URI, typ at+jwt", () => {
    expect(decodeJwt(token).aud).toBe(API);
    expect(decodeProtectedHeader(token).typ).toBe("at+jwt");
  });

  test("the HTTP edge answers 200, 401 and 403 with their challenges", async () => {
    const serve = handler(keys, trust);
    const ask = (method: string, bearer?: string) =>
      serve(
        new Request("https://api.guide.test/invoices/42", {
          method,
          headers:
            bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
        }),
      );
    expect((await ask("GET", token)).status).toBe(200);
    const anonymous = await ask("GET");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe(
      'Bearer realm="api"',
    );
    const forged = await ask("GET", `${token}x`);
    expect(forged.status).toBe(401);
    expect(forged.headers.get("www-authenticate")).toBe(
      challenge("invalid_token"),
    );
    const refused = await ask("DELETE", token);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toMatch(
      /^Bearer error="insufficient_scope", scope="invoices:delete"$/,
    );
    expect(await refused.json()).toEqual({ code: "auth.errors.forbidden" });
  });

  test("a client_credentials token is a client, decided on scope alone", async () => {
    const registered = await registerClient(
      {
        detailTypes: noDetailTypes,
        now: () => new Date(),
        db: oauthDb,
        findTenant: (slug) => mongo.db.tenants.findFirst({ slug }),
      },
      {
        tenant: SLUG,
        name: "machine",
        clientId: "guide-machine",
        redirectUris: [],
        type: "confidential",
        grants: [CLIENT_CREDENTIALS_GRANT],
        allowedScopes: ["invoices:read"],
      },
    );
    const response = await flow.post(
      SLUG,
      "/token",
      {
        grant_type: CLIENT_CREDENTIALS_GRANT,
        resource: API,
        scope: "invoices:read",
      },
      flow.basic("guide-machine", registered.clientSecret ?? ""),
    );
    const machine = defined(
      (await jsonOf(response, answerBody)).access_token,
      "token",
    );
    const claims = claimsOf(await verifyAccessToken(machine, keys, trust));
    expect(claims.subject).toEqual({ type: "client", id: "guide-machine" });
    expect(claims).not.toHaveProperty("permissions");
    const on = (method: string, path: string) =>
      authorize({ method, path, token: machine }, keys, trust);
    expect(await on("GET", "/invoices")).toEqual({ allow: true });
    expect(await on("POST", "/invoices")).toMatchObject({ allow: false });
  });

  test("relations: the permission and the relation must both hold", async () => {
    expect(modelIssues).toEqual([]);
    await access.grant({ type: "invoice", id: "42" }, "owners", {
      type: "user",
      id: "alice",
    });
    const owned = (id: string) =>
      authorizeOwned(
        { method: "GET", path: `/invoices/${id}`, token },
        keys,
        trust,
      );
    expect(await owned("42")).toEqual({ allow: true });
    expect(await owned("43")).toMatchObject({
      allow: false,
      refusal: { status: 404 },
    });
  });
});
