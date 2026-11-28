import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { resourcesService } from "@/config/resources";
import { createExclusive } from "@/console/exclusive";
import { withMembers } from "~/members";
import { permissionsOfRole, scopeLoader } from "./roles.data-loader";

// A tenant id of its own: the services read through the tenant scope.
const tenant = new ObjectId();
const request = () => withMembers({ exclusive: createExclusive(null) });

afterAll(async () => {
  await mongo.db.resources.raw.deleteMany({ tenantId: tenant });
  await mongo.db.scopes.raw.deleteMany({ tenantId: tenant });
});

describe("role permissions loader", () => {
  test("roles sharing scopes read them in one query, by name, and a dangling id is left out", async () => {
    const resource = await resourcesService.createResource(tenant, "dl-roles", {
      uri: "https://api.dl-roles.example/v1",
    });
    await resourcesService.replaceResourceScopes(tenant, resource._id, [
      "write",
      "read",
    ]);
    const [first, second] = (
      await resourcesService.listScopes(tenant, { resourceId: resource._id })
    ).map((scope) => scope._id.toHexString());
    const dangling = new ObjectId().toHexString();
    if (first === undefined || second === undefined) throw new Error("scopes");
    const ctx = request();
    const reads = spyOn(resourcesService, "findScopes");
    try {
      const [one, two, three] = await Promise.all([
        permissionsOfRole(ctx, {
          tenantId: tenant.toHexString(),
          permissionIds: [first, second],
        }),
        permissionsOfRole(ctx, {
          tenantId: tenant.toHexString(),
          permissionIds: [second],
        }),
        permissionsOfRole(ctx, {
          tenantId: tenant.toHexString(),
          permissionIds: [dangling, first],
        }),
      ]);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(one.map((scope) => scope.name)).toEqual(["read", "write"]);
      expect(two).toHaveLength(1);
      expect(three).toHaveLength(1);
      expect(await scopeLoader(ctx, tenant.toHexString()).load(dangling)).toBe(
        null,
      );
    } finally {
      reads.mockRestore();
    }
  });

  test("a role with no permission reads none", async () => {
    expect(
      await permissionsOfRole(request(), {
        tenantId: tenant.toHexString(),
        permissionIds: [],
      }),
    ).toEqual([]);
  });
});
