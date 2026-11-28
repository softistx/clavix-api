import { afterAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { rolesService } from "@/config/roles";
import { mongoScopeClients } from "./resources.client-scopes";

const tenant = new ObjectId();
const HOLDERS = 27;

afterAll(async () => {
  await mongo.db.roles.raw.deleteMany({ tenantId: tenant });
  await oauthDb
    .collection("oauthPartitionedClients")
    .deleteMany({ partition: tenant.toHexString() });
});

describe("the reader ports stop at their limit", () => {
  test("mongoScopeClients returns at most `limit` of 27 clients", async () => {
    await oauthDb.collection("oauthPartitionedClients").insertMany(
      Array.from({ length: HOLDERS }, (_, i) => ({
        _id: `cap-client-${i}` as never,
        name: `cap-client-${i}`,
        redirectUris: ["https://app.example/cb"],
        source: "registered",
        createdAt: new Date(),
        expiresAt: null,
        partition: tenant.toHexString(),
        ...(i % 2 === 0
          ? { allowedScopes: ["capped"] }
          : { defaultScopes: ["capped"] }),
      })),
    );
    const port = mongoScopeClients(oauthDb);
    expect(await port.listing(tenant, "capped", 26)).toHaveLength(26);
    expect(await port.listing(tenant, "capped", 100)).toHaveLength(HOLDERS);
    expect(await port.listing(new ObjectId(), "capped", 26)).toEqual([]);
  });

  test("rolesGranting returns at most `limit` of 27 roles", async () => {
    const scope = new ObjectId();
    for (let i = 0; i < HOLDERS; i++) {
      const role = await rolesService.create(tenant, { name: `cap-role-${i}` });
      await mongo.db.roles.raw.updateOne(
        { _id: role._id },
        { $set: { permissionIds: [scope] } },
      );
    }
    expect(await rolesService.rolesGranting(tenant, scope, 26)).toHaveLength(
      26,
    );
    expect(await rolesService.rolesGranting(tenant, scope, 100)).toHaveLength(
      HOLDERS,
    );
  });
});
