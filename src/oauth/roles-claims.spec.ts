import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeJwt } from "jose";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { resourcesService } from "@/config/resources";
import { rolesFor, rolesService } from "@/config/roles";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { createFlow } from "~/oauth-flow";

const X = "https://x.roles.test/api";
const Y = "https://y.roles.test/api";
const flow = createFlow({ rolesFor });

let a = new ObjectId();
let b = new ObjectId();

const claimsOf = (token: string | undefined) =>
  decodeJwt(token ?? "")["roles"] as string[] | undefined;

beforeAll(async () => {
  a = new ObjectId((await flow.setUp("roles-a", [X, Y])).tenantId);
  b = new ObjectId((await flow.setUp("roles-b", [X])).tenantId);
  const resources = await resourcesService.listResources(a);
  const resourceX = resources.find((r) => r.uri === X);
  const wide = await rolesService.create(a, { name: "member" });
  const onX = await rolesService.create(a, {
    name: "editor",
    resourceId: resourceX?._id.toHexString(),
  });
  const alsoWide = await rolesService.create(a, { name: "auditor" });
  for (const role of [wide, onX, alsoWide]) {
    await rolesService.assign(a, role._id.toHexString(), "user-roles-a");
  }
  // Tenant B has a role of the same name held by the same user id.
  const other = await rolesService.create(b, { name: "b-only" });
  await rolesService.assign(b, other._id.toHexString(), "user-roles-a");
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

describe("the roles claim", () => {
  test("the id_token carries the tenant-wide roles, not those of a resource", async () => {
    const tokens = await flow.tokensOf("roles-a", "openid email", {
      userId: "user-roles-a",
    });
    expect(claimsOf(tokens.id_token)).toEqual(["auditor", "member"]);
  });

  test("userinfo carries the same roles", async () => {
    const tokens = await flow.tokensOf("roles-a", "openid email", {
      userId: "user-roles-a",
    });
    const response = await flow.get(
      "roles-a",
      "/userinfo",
      `Bearer ${tokens.access_token}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["roles"]).toEqual(["auditor", "member"]);
    expect(body["email"]).toBe("user-roles-a@end.test");
  });

  test("an access token for resource X carries the tenant-wide roles and X's", async () => {
    const tokens = await flow.tokensOf("roles-a", "read", {
      resource: X,
      userId: "user-roles-a",
    });
    expect(claimsOf(tokens.access_token)).toEqual([
      "auditor",
      "editor",
      "member",
    ]);
  });

  test("a role scoped to X is absent from a token for resource Y", async () => {
    const tokens = await flow.tokensOf("roles-a", "read", {
      resource: Y,
      userId: "user-roles-a",
    });
    expect(claimsOf(tokens.access_token)).toEqual(["auditor", "member"]);
  });

  test("a user with no role gets an empty list, never another tenant's roles", async () => {
    const tokens = await flow.tokensOf("roles-b", "read", {
      resource: X,
      userId: "user-nobody",
    });
    expect(claimsOf(tokens.access_token)).toEqual([]);
    // The same user id holds `b-only` in B and three roles in A: each tenant answers its own.
    const own = await flow.tokensOf("roles-b", "read", {
      resource: X,
      userId: "user-roles-a",
    });
    expect(claimsOf(own.access_token)).toEqual(["b-only"]);
  });

  test("a refreshed token carries the user's current roles", async () => {
    const tokens = await flow.tokensOf("roles-a", "read", {
      resource: X,
      userId: "user-refresh",
    });
    const role = await rolesService.create(a, { name: "late" });
    await rolesService.assign(a, role._id.toHexString(), "user-refresh");
    const client = flow.clients["roles-a"] as { id: string; secret: string };
    const refreshed = await flow.post(
      "roles-a",
      "/token",
      {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token ?? "",
        resource: X,
      },
      flow.basic(client.id, client.secret),
    );
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as { access_token: string };
    expect(claimsOf(body.access_token)).toEqual(["late"]);
  });

  test("a token with no resource (the userinfo one) carries the tenant-wide roles only", async () => {
    const tokens = await flow.tokensOf("roles-a", "openid", {
      userId: "user-roles-a",
    });
    expect(claimsOf(tokens.access_token)).toEqual(["auditor", "member"]);
  });
});
