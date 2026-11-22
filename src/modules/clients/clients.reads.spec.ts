import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { agentClientsService } from "@/config/agent-clients";
import { mongo } from "@/config/db";
import { noDetailTypes } from "@/config/no-ops";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import {
  countClients,
  findClientView,
  listClientPage,
  matchesClient,
  refuseAgent,
  requireClientView,
} from "./clients.reads";
import { registerClient } from "./clients.register";

const REDIRECT = "https://app.example/callback";
const reads = { db: oauthDb, agents: agentClientsService };
let tenant = { _id: new ObjectId(), slug: "rds-a", status: "active" } as const;
let consoleId = "";
let agentId = "";

beforeAll(async () => {
  const created = await tenantsService.create({ slug: "rds-a", name: "A" });
  tenant = { ...tenant, _id: new ObjectId(created.id) };
  await mongo.db.tenants.raw.updateMany(
    { slug: "rds-a" },
    { $set: { quotaOverrides: { clients: 1000 } } },
  );
  const options = {
    detailTypes: noDetailTypes,
    now: () => new Date(),
    db: oauthDb,
    findTenant: (slug: string) => mongo.db.tenants.findFirst({ slug }),
  };
  consoleId = (
    await registerClient(options, {
      tenant: "rds-a",
      name: "Console",
      redirectUris: [REDIRECT],
    })
  ).clientId;
  agentId = (
    await registerClient(options, {
      tenant: "rds-a",
      name: "Agent",
      redirectUris: [REDIRECT],
    })
  ).clientId;
  await agentClientsService.record(created.id, {
    clientId: agentId,
    kind: "dynamic",
  });
});
afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.agentClients.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

describe("the client reads", () => {
  test("find returns a console client and an unknown one as null", async () => {
    expect((await findClientView(reads, tenant, consoleId))?.clientId).toBe(
      consoleId,
    );
    expect(await findClientView(reads, tenant, "nope")).toBeNull();
  });

  test("a registered agent is read like any client", async () => {
    expect((await findClientView(reads, tenant, agentId))?.registration).toBe(
      "dynamic",
    );
  });

  test("refuseAgent refuses an agent as an unknown client, not a console client", async () => {
    await expect(refuseAgent(reads, tenant, agentId)).rejects.toThrow(
      "No such client",
    );
    await refuseAgent(reads, tenant, consoleId);
  });

  test("require refuses an unknown client", async () => {
    await expect(requireClientView(reads, tenant, "nope")).rejects.toThrow(
      "No such client",
    );
  });

  test("list and count see the agents, and count follows the kinds filter", async () => {
    expect(await countClients(reads, tenant)).toBe(2);
    expect(await countClients(reads, tenant, { kinds: ["dynamic"] })).toBe(1);
    const page = await listClientPage(reads, tenant, { limit: 10 });
    expect(page.items.map((item) => item.clientId).sort()).toEqual(
      [consoleId, agentId].sort(),
    );
  });

  test("list refuses an over-long cursor and an over-long query", async () => {
    await expect(
      listClientPage(reads, tenant, { limit: 10, after: "x".repeat(10_000) }),
    ).rejects.toThrow("Unknown cursor");
    await expect(
      countClients(reads, tenant, { q: "x".repeat(10_000) }),
    ).rejects.toThrow();
  });

  test("matches is false for an id that is not stored", async () => {
    expect(
      await matchesClient(reads, tenant, {
        name: "Nobody",
        clientId: "nobody",
        redirectUris: [REDIRECT],
        type: "public",
      }),
    ).toBe(false);
  });
});
