import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CLIENT_CREDENTIALS_GRANT,
  TOKEN_EXCHANGE_GRANT,
} from "@softistx/janus-oauth";
import { decodeJwt } from "jose";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { clientPoliciesService } from "@/config/client-policies";
import { mongo } from "@/config/db";
import { noDetailTypes } from "@/config/no-ops";
import { oauthDb } from "@/config/oauth-db";
import { registerStoredResource, resourcesService } from "@/config/resources";
import { permissionsFor, rolesFor, rolesService } from "@/config/roles";
import { registerClient } from "@/modules/clients";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { jsonOf, tokenBody } from "~/json";
import { defined, parsed } from "~/narrow";
import { answerBody, recordBody } from "~/oauth-bodies";
import { createFlow } from "~/oauth-flow";

const ON = "https://on.perm.test/api";
const OFF = "https://off.perm.test/api";
const SLUG = "perm-a";
const flow = createFlow({ rolesFor, permissionsFor });
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });

let tenantId = new ObjectId();
const roleIds: Record<string, string> = {};

const permissionsOf = (token: string | undefined) =>
  parsed(z.array(z.string()).optional(), decodeJwt(token ?? "")["permissions"]);

const scopeId = async (resourceUri: string, name: string) => {
  const resource = defined(
    (await resourcesService.listResources(tenantId)).find(
      (r) => r.uri === resourceUri,
    ),
    resourceUri,
  );
  const scope = defined(
    (
      await resourcesService.listScopes(tenantId, { resourceId: resource._id })
    ).find((s) => s.name === name),
    name,
  );
  return scope._id.toHexString();
};

const role = async (
  name: string,
  uri: string | null,
  grants: [string, string][],
  users: string[],
) => {
  const resource =
    uri === null
      ? undefined
      : (await resourcesService.listResources(tenantId)).find(
          (r) => r.uri === uri,
        );
  const created = await rolesService.create(tenantId, {
    name,
    resourceId: resource?._id.toHexString(),
  });
  const id = created._id.toHexString();
  roleIds[name] = id;
  await rolesService.setPermissions(
    tenantId,
    id,
    await Promise.all(grants.map(([u, n]) => scopeId(u, n))),
  );
  for (const user of users) await rolesService.assign(tenantId, id, user);
};

beforeAll(async () => {
  tenantId = new ObjectId((await flow.setUp(SLUG, [])).tenantId);
  await registerStoredResource({
    tenant: SLUG,
    uri: ON,
    scopes: ["read", "write", "admin"],
  });
  await registerStoredResource({
    tenant: SLUG,
    uri: OFF,
    scopes: ["read", "write"],
  });
  for (const uri of [ON, OFF]) {
    const found = defined(
      (await resourcesService.listResources(tenantId)).find(
        (r) => r.uri === uri,
      ),
      uri,
    );
    await resourcesService.updateResource(tenantId, found._id.toHexString(), {
      allowClientCredentials: true,
      ...(uri === ON ? { enforceRbac: true } : {}),
    });
  }
  // Tenant-wide role: one scope per resource; scoped role: its own resource only.
  await role(
    "reader",
    null,
    [
      [ON, "read"],
      [OFF, "read"],
    ],
    ["u-both"],
  );
  await role(
    "writer",
    ON,
    [
      [ON, "write"],
      [ON, "read"],
    ],
    ["u-both"],
  );
  await role("off-only", OFF, [[OFF, "write"]], ["u-off"]);
  await role("late", null, [[ON, "admin"]], []);
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

describe("the permissions claim", () => {
  test("it holds the sorted, de-duplicated scopes of the resource the user's roles grant", async () => {
    const tokens = await flow.tokensOf(SLUG, "read", {
      resource: ON,
      userId: "u-both",
    });
    expect(permissionsOf(tokens.access_token)).toEqual(["read", "write"]);
  });

  test("a scoped role grants only its own resource's scopes", async () => {
    const tokens = await flow.tokensOf(SLUG, "read", {
      resource: ON,
      userId: "u-off",
    });
    expect(permissionsOf(tokens.access_token)).toEqual([]);
  });

  test("a user holding no role gets an empty list on a resource that enforces RBAC", async () => {
    const tokens = await flow.tokensOf(SLUG, "read", {
      resource: ON,
      userId: "u-nobody",
    });
    expect(decodeJwt(tokens.access_token ?? "")["permissions"]).toEqual([]);
  });

  test("with the flag off there is no claim", async () => {
    const tokens = await flow.tokensOf(SLUG, "read", {
      resource: OFF,
      userId: "u-both",
    });
    expect(decodeJwt(tokens.access_token ?? "")).not.toHaveProperty(
      "permissions",
    );
  });

  test("it never reaches the id_token or userinfo", async () => {
    const tokens = await flow.tokensOf(SLUG, "openid", { userId: "u-both" });
    expect(decodeJwt(tokens.id_token ?? "")).not.toHaveProperty("permissions");
    expect(decodeJwt(tokens.access_token ?? "")).not.toHaveProperty(
      "permissions",
    );
    const response = await flow.get(
      SLUG,
      "/userinfo",
      `Bearer ${tokens.access_token}`,
    );
    expect(await jsonOf(response, recordBody)).not.toHaveProperty(
      "permissions",
    );
  });

  test("a revoked role is gone from the next token after a refresh", async () => {
    await rolesService.assign(tenantId, roleIds["late"] ?? "", "u-refresh");
    const tokens = await flow.tokensOf(SLUG, "read", {
      resource: ON,
      userId: "u-refresh",
    });
    expect(permissionsOf(tokens.access_token)).toEqual(["admin"]);
    await rolesService.unassign(tenantId, roleIds["late"] ?? "", "u-refresh");
    const client = defined(flow.clients[SLUG], "the client");
    const refreshed = await flow.post(
      SLUG,
      "/token",
      {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token ?? "",
        resource: ON,
      },
      flow.basic(client.id, client.secret),
    );
    expect(refreshed.status).toBe(200);
    const body = await jsonOf(refreshed, tokenBody);
    expect(permissionsOf(body.access_token)).toEqual([]);
  });

  test("a client_credentials token has no permissions claim", async () => {
    const registered = await registerClient(
      {
        detailTypes: noDetailTypes,
        now: () => new Date(),
        db: oauthDb,
        findTenant,
      },
      {
        tenant: SLUG,
        name: "machine",
        clientId: "perm-machine",
        redirectUris: [],
        type: "confidential",
        grants: [CLIENT_CREDENTIALS_GRANT],
        allowedScopes: ["read"],
      },
    );
    const response = await flow.post(
      SLUG,
      "/token",
      { grant_type: CLIENT_CREDENTIALS_GRANT, resource: ON, scope: "read" },
      flow.basic("perm-machine", registered.clientSecret ?? ""),
    );
    expect(response.status).toBe(200);
    const body = await jsonOf(response, answerBody);
    expect(decodeJwt(body.access_token ?? "")).not.toHaveProperty(
      "permissions",
    );
  });

  test("a token exchange carries the subject user's permissions on the target", async () => {
    const registered = await registerClient(
      {
        detailTypes: noDetailTypes,
        now: () => new Date(),
        db: oauthDb,
        findTenant,
      },
      {
        tenant: SLUG,
        name: "Exchanger",
        clientId: "perm-exch",
        redirectUris: [],
        type: "confidential",
        grants: [TOKEN_EXCHANGE_GRANT],
      },
    );
    await clientPoliciesService.setTokenExchange(tenantId, "perm-exch", {
      targetResources: [ON],
      subjectClients: ["backend"],
      subjectAgents: false,
      mode: "delegation",
    });
    const source = await flow.tokensOf(SLUG, "read", {
      resource: OFF,
      userId: "u-both",
    });
    const response = await flow.post(
      SLUG,
      "/token",
      {
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: source.access_token ?? "",
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        resource: ON,
      },
      flow.basic("perm-exch", registered.clientSecret ?? ""),
    );
    expect(response.status).toBe(200);
    const body = await jsonOf(response, answerBody);
    expect(permissionsOf(body.access_token)).toEqual(["read", "write"]);
  });
});
