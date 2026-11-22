import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { ObjectId } from "mongodb";
import { noDetailTypes } from "@/config/no-ops";
import { registerClient } from "@/modules/clients";
import { PLATFORM_TENANT_SLUG, partitionOf } from "@/modules/tenants";
import { agentClientsService } from "./agent-clients";
import { createAgentsPrune } from "./agents-prune";
import { clientsService } from "./clients";
import { mongo } from "./db";
import { oauthDb } from "./oauth-db";
import { tenantsService } from "./tenancy";

const REDIRECT = "https://app.example/callback";
const NOW = new Date("2026-11-17T12:00:00Z");
const DAY = 86_400_000;
const options = {
  db: oauthDb,
  findTenant: (slug: string) => mongo.db.tenants.findFirst({ slug }),
  now: () => NOW,
  detailTypes: noDetailTypes,
};
let idA = "";
let idB = "";
const storeOf = (id: string) =>
  createMongoOAuth(oauthDb, { partition: partitionOf(new ObjectId(id)) });

async function agent(
  slug: string,
  id: string,
  name: string,
  ageDays: number,
  kind: "dynamic" | "metadata" = "dynamic",
) {
  const made = await registerClient(options, {
    tenant: slug,
    name,
    redirectUris: [REDIRECT],
  });
  await agentClientsService.record(id, {
    clientId: made.clientId,
    kind,
  });
  await mongo.db.agentClients.raw.updateOne(
    { clientId: made.clientId },
    { $set: { createdAt: new Date(NOW.getTime() - ageDays * DAY) } },
  );
  return made.clientId;
}

beforeAll(async () => {
  idA = (await tenantsService.create({ slug: "prn-a", name: "A" })).id;
  idB = (await tenantsService.create({ slug: "prn-b", name: "B" })).id;
  await mongo.db.tenants.raw.updateMany(
    { slug: { $in: ["prn-a", "prn-b"] } },
    { $set: { quotaOverrides: { clients: 1000, agents: 1000 } } },
  );
});
afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.agentClients.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

describe("createAgentsPrune over the real stores", () => {
  test("deletes the old agents with no standing grant, closes their tokens, spares the rest", async () => {
    const old = await agent("prn-a", idA, "Old", 8);
    const young = await agent("prn-a", idA, "Young", 6);
    const used = await agent("prn-a", idA, "Used", 30);
    const revoked = await agent("prn-a", idA, "Revoked", 30);
    const otherTenant = await agent("prn-b", idB, "B old", 30);
    // A metadata-document agent is pruned under the same rule.
    const document = await agent("prn-a", idA, "Doc", 9, "metadata");
    const store = storeOf(idA);
    const t = new Date(NOW.getTime());
    const grant = (id: string, clientId: string, revokedAt: Date | null) =>
      store.upsertGrant({
        id,
        userId: "u1",
        clientId,
        resource: "https://api.example/v1",
        scopes: ["read"],
        createdAt: t,
        updatedAt: t,
        revokedAt,
      });
    await grant("prn-g-used", used, null);
    await grant("prn-g-revoked", revoked, null);
    await store.revokeGrant("prn-g-revoked", t);
    await grant("prn-g-old", old, null);
    await store.revokeGrant("prn-g-old", t);
    await store.insertAccessToken({
      tokenHash: "prn-access",
      grantId: "prn-g-old",
      userId: "u1",
      clientId: old,
      resource: "https://api.example/v1",
      scopes: ["read"],
      createdAt: t,
      expiresAt: new Date(NOW.getTime() + DAY),
      revokedAt: null,
    });

    const report = await createAgentsPrune(() => NOW)();
    expect(report).toEqual({ pruned: 4, failed: 0 });
    expect(await agentClientsService.has(idA, document)).toBe(false);

    expect(await store.findClient(old)).toBeNull();
    expect(await agentClientsService.has(idA, old)).toBe(false);
    expect(
      (await store.findAccessToken("prn-access"))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(await store.findClient(revoked)).toBeNull();

    expect(await store.findClient(young)).not.toBeNull();
    expect(await store.findClient(used)).not.toBeNull();
    expect(await agentClientsService.has(idA, used)).toBe(true);
    // The other tenant's agent is old and unused: pruned in its own right.
    expect(await storeOf(idB).findClient(otherTenant)).toBeNull();

    const events = await mongo.db.adminEvents.raw
      .find({ action: "agent.prune" })
      .toArray();
    expect(events.map((e) => e["target"].id).sort()).toEqual(
      [old, otherTenant, revoked, document].sort(),
    );
    expect(events.every((e) => e["actor"] === "system:agents:prune")).toBe(
      true,
    );
  });

  test("deletes through the real tenant, not a stand-in with an empty slug", async () => {
    const id = await agent("prn-a", idA, "Real tenant", 20);
    const spy = spyOn(clientsService, "delete");
    try {
      await createAgentsPrune(() => NOW)();
      const call = spy.mock.calls.find(([, clientId]) => clientId === id);
      expect(call?.[0]).toMatchObject({
        _id: new ObjectId(idA),
        slug: "prn-a",
        status: "active",
      });
    } finally {
      spy.mockRestore();
    }
    expect(await storeOf(idA).findClient(id)).toBeNull();
  });

  test("a tenant that is gone removes nothing", async () => {
    const id = await agent("prn-a", idA, "Gone tenant", 20);
    const spy = spyOn(tenantsService, "find").mockResolvedValue(undefined);
    try {
      const report = await createAgentsPrune(() => NOW)();
      expect(report.pruned).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(await storeOf(idA).findClient(id)).not.toBeNull();
    await createAgentsPrune(() => NOW)();
  });

  test("a second pass finds nothing: no pruning, no event", async () => {
    const before = await mongo.db.adminEvents.raw.countDocuments({
      action: "agent.prune",
    });
    expect(await createAgentsPrune(() => NOW)()).toEqual({
      pruned: 0,
      failed: 0,
    });
    expect(
      await mongo.db.adminEvents.raw.countDocuments({ action: "agent.prune" }),
    ).toBe(before);
  });
});
