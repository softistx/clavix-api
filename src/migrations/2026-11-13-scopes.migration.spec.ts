import { beforeEach, describe, expect, test } from "bun:test";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { getCollection } from "@softistx/mongo";
import { migrate, rollback } from "@softistx/mongo/migrations";
import type { Db, ObjectId } from "mongodb";
import { registerClient } from "@/clients/register-client";
import { clientIndex, scopes, tenants } from "@/modules/collections";
import { partitionOf } from "@/modules/tenants/identity";
import { freshMigrationDb } from "~/migrations";
import { clavixTenant } from "./2026-11-10-clavix-tenant.migration";
import { id, scopesMigration } from "./2026-11-13-scopes.migration";

const API = "https://api.example/v1";
let db: Db;
let tenantId: ObjectId;
let other: ObjectId;

// Resources as the code before this migration stored them: scopes as strings.
const legacy = (tenant: ObjectId, uri: string, names: string[]) =>
  db.collection("resources").insertOne({
    tenantId: tenant,
    uri,
    name: uri,
    scopes: names,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
const scopeDocs = () =>
  db.collection("scopes").find().sort({ name: 1 }).toArray();
const again = async () => {
  // Forget the record so the migration runs again on the same data.
  await db.collection("nxgt_migrations").deleteMany({ _id: id as never });
  await migrate(db, [clavixTenant, scopesMigration]);
};

beforeEach(async () => {
  db = await freshMigrationDb();
  await migrate(db, [clavixTenant]);
  const all = getCollection(db, tenants);
  tenantId = (await all.findFirst({ slug: "clavix" }))?._id as ObjectId;
  other = (await all.create({ slug: "mig-b", name: "B", status: "active" }))
    ._id;
});

describe(id, () => {
  test("up moves each resource's strings to Scope documents and removes them", async () => {
    const { insertedId: first } = await legacy(tenantId, API, [
      "read",
      "write",
      "read",
    ]);
    const { insertedId: second } = await legacy(other, API, ["read"]);
    await migrate(db, [clavixTenant, scopesMigration]);
    expect(
      (await scopeDocs()).map((scope) => [
        scope["name"],
        String(scope["tenantId"]),
        String(scope["resourceId"]),
      ]),
    ).toEqual(
      [
        ["read", String(tenantId), String(first)],
        ["read", String(other), String(second)],
        ["write", String(tenantId), String(first)],
      ].sort(),
    );
    for (const scope of await scopeDocs()) {
      expect(scope).toMatchObject({
        description: { fr: "", en: "" },
        claims: [],
      });
    }
    const stored = await db.collection("resources").find().toArray();
    expect(stored.every((resource) => !("scopes" in resource))).toBe(true);
  });

  test("two resources of one tenant keep their scope of the same name", async () => {
    await legacy(tenantId, API, ["read"]);
    await legacy(tenantId, "https://billing.example/", ["read"]);
    await migrate(db, [clavixTenant, scopesMigration]);
    expect(await scopeDocs()).toHaveLength(2);
  });

  test("a second run creates nothing and keeps the texts written since", async () => {
    await legacy(tenantId, API, ["read"]);
    await migrate(db, [clavixTenant, scopesMigration]);
    await db
      .collection("scopes")
      .updateOne({ name: "read" }, { $set: { "description.en": "Read" } });
    await again();
    const found = await scopeDocs();
    expect(found).toHaveLength(1);
    expect(found[0]?.["description"]).toEqual({ fr: "", en: "Read" });
  });

  test("up lists the clients the janus store holds, each in its tenant, once", async () => {
    const findTenant = (slug: string) =>
      getCollection(db, tenants).findFirst({ slug });
    const made = await registerClient(
      { db, findTenant },
      {
        tenant: "clavix",
        name: "Back end",
        redirectUris: ["https://app.example/cb"],
        type: "confidential",
      },
    );
    await registerClient(
      { db, findTenant },
      {
        tenant: "mig-b",
        name: "Mobile",
        redirectUris: ["https://b.example/cb"],
      },
    );
    await migrate(db, [clavixTenant, scopesMigration]);
    await again();
    const listed = await db
      .collection("clientIndex")
      .find()
      .sort({ clientId: 1 })
      .toArray();
    expect(
      listed.map((entry) => [
        entry["clientId"],
        String(entry["tenantId"]),
        entry["type"],
      ]),
    ).toEqual([
      ["back-end", String(tenantId), "confidential"],
      ["mobile", String(other), "public"],
    ]);
    // The list holds no secret, plain or hashed.
    expect(JSON.stringify(listed)).not.toContain(made.clientSecret as string);
    const stored = await createMongoOAuth(db, {
      partition: partitionOf(tenantId),
    }).findClient("back-end");
    expect(JSON.stringify(listed)).not.toContain(stored?.secretHash as string);
    expect(await getCollection(db, clientIndex).raw.countDocuments()).toBe(2);
  });

  test("down puts the strings back and empties the scopes and the list", async () => {
    await legacy(tenantId, API, ["read", "write"]);
    await migrate(db, [clavixTenant, scopesMigration]);
    await rollback(db, [clavixTenant, scopesMigration]);
    const [resource] = await db.collection("resources").find().toArray();
    expect([...((resource?.["scopes"] ?? []) as string[])].sort()).toEqual([
      "read",
      "write",
    ]);
    expect(await getCollection(db, scopes).raw.countDocuments()).toBe(0);
    expect(await db.collection("clientIndex").countDocuments()).toBe(0);
  });
});
