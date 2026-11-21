import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { access } from "@/config/access";
import { agentClientsService } from "@/config/agent-clients";
import { clientsService } from "@/config/clients";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import { registerClient } from "@/modules/clients";
import { PLATFORM_TENANT_SLUG, partitionOf } from "@/modules/tenants";
import { codeOf, consoleAs } from "~/console";

const REDIRECT = "https://app.example/callback";
const DOC = "https://agent.example/client.json";
const admin = consoleAs("agc-admin");
const viewer = consoleAs("agc-viewer");
const other = consoleAs("agc-other");

let tenantA = "";
let tenantB = "";

const CLIENT = "id name registration createdAt";
const LIST = `query($tenantId: ID!, $q: String, $kind: [ClientRegistration!], $after: String, $first: Int) {
  clients(tenantId: $tenantId, q: $q, kind: $kind, after: $after, first: $first) {
    items { ${CLIENT} } nextCursor totalCount
  }
}`;
const GET = `query($tenantId: ID!, $id: ID!) { client(tenantId: $tenantId, id: $id) { ${CLIENT} } }`;
const DELETE = `mutation($tenantId: ID!, $id: ID!) { deleteClient(tenantId: $tenantId, id: $id) }`;
const UPDATE = `mutation($tenantId: ID!, $id: ID!, $input: UpdateClientInput!) {
  updateClient(tenantId: $tenantId, id: $id, input: $input) { ${CLIENT} }
}`;

type Page = {
  items: { id: string; registration: string }[];
  nextCursor: string | null;
  totalCount: number;
};
const list = async (
  as: typeof admin,
  tenantId: string,
  variables: Record<string, unknown> = {},
) => {
  const result = await as(LIST, { tenantId, ...variables });
  expect(result.errors).toBeUndefined();
  return result.data?.["clients"] as Page;
};
const idsOf = (page: Page) => page.items.map((item) => item.id);

const storeOf = (tenantId: string) =>
  createMongoOAuth(oauthDb, { partition: partitionOf(tenantOf(tenantId)) });
const tenantOf = (tenantId: string) => {
  const { ObjectId } = require("mongodb") as typeof import("mongodb");
  return new ObjectId(tenantId);
};

/** A client that registered itself: `registered` in janus, `dynamic` in the agents store. */
async function dynamicAgent(slug: string, tenantId: string, name: string) {
  const made = await registerClient(
    {
      now: () => new Date(),
      db: oauthDb,
      findTenant: (s) => mongo.db.tenants.findFirst({ slug: s }),
    },
    { tenant: slug, name, redirectUris: [REDIRECT] },
  );
  await agentClientsService.record(tenantId, {
    clientId: made.clientId,
    kind: "dynamic",
  });
  return made.clientId;
}

/** A client read from a metadata document: `metadata` in janus, recorded as an agent. */
async function metadataAgent(tenantId: string, id: string) {
  await storeOf(tenantId).upsertClient({
    id,
    name: "Doc agent",
    redirectUris: [REDIRECT],
    source: "metadata",
    createdAt: new Date("2026-11-10T00:00:00Z"),
    expiresAt: new Date("2099-01-01T00:00:00Z"),
  });
  await agentClientsService.record(tenantId, {
    clientId: id,
    kind: "metadata",
  });
}

beforeAll(async () => {
  tenantA = (await tenantsService.create({ slug: "agc-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "agc-b", name: "B" })).id;
  await access.grantTenant(tenantA, "agc-admin", "admin");
  await access.grantTenant(tenantA, "agc-viewer", "viewer");
  await access.grantTenant(tenantB, "agc-other", "admin");
  await mongo.db.tenants.raw.updateMany(
    { slug: { $in: ["agc-a", "agc-b"] } },
    { $set: { quotaOverrides: { clients: 1000 } } },
  );
  await registerClient(
    {
      now: () => new Date(),
      db: oauthDb,
      findTenant: (s) => mongo.db.tenants.findFirst({ slug: s }),
    },
    { tenant: "agc-a", name: "Console one", redirectUris: [REDIRECT] },
  );
  await registerClient(
    {
      now: () => new Date(),
      db: oauthDb,
      findTenant: (s) => mongo.db.tenants.findFirst({ slug: s }),
    },
    { tenant: "agc-a", name: "Console two", redirectUris: [REDIRECT] },
  );
  await dynamicAgent("agc-a", tenantA, "Dynamic one");
  await metadataAgent(tenantA, DOC);
  // Tenant B: one console client and one agent, never seen from A.
  await registerClient(
    {
      now: () => new Date(),
      db: oauthDb,
      findTenant: (s) => mongo.db.tenants.findFirst({ slug: s }),
    },
    { tenant: "agc-b", name: "B console", redirectUris: [REDIRECT] },
  );
  await dynamicAgent("agc-b", tenantB, "B agent");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.agentClients.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

describe("clients(kind:)", () => {
  test("without a kind every client is listed, each with its registration", async () => {
    const page = await list(admin, tenantA);
    expect(page.totalCount).toBe(4);
    expect(
      Object.fromEntries(page.items.map((i) => [i.id, i.registration])),
    ).toEqual({
      "console-one": "CONSOLE",
      "console-two": "CONSOLE",
      "dynamic-one": "DYNAMIC",
      [DOC]: "METADATA",
    });
  });

  test("CONSOLE lists the registered clients, and DYNAMIC with METADATA the agents", async () => {
    const consoleClients = await list(admin, tenantA, { kind: ["CONSOLE"] });
    expect(idsOf(consoleClients)).toEqual(["console-one", "console-two"]);
    expect(consoleClients.totalCount).toBe(2);
    const agents = await list(admin, tenantA, {
      kind: ["DYNAMIC", "METADATA"],
    });
    expect(idsOf(agents).sort()).toEqual([DOC, "dynamic-one"].sort());
    expect(agents.totalCount).toBe(2);
    expect(idsOf(await list(admin, tenantA, { kind: ["METADATA"] }))).toEqual([
      DOC,
    ]);
    // An empty list is no filter.
    expect((await list(admin, tenantA, { kind: [] })).totalCount).toBe(4);
  });

  test("totalCount ignores the cursor and the page size, and follows q and kind", async () => {
    const first = await list(admin, tenantA, {
      kind: ["DYNAMIC", "METADATA"],
      first: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.totalCount).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(admin, tenantA, {
      kind: ["DYNAMIC", "METADATA"],
      first: 1,
      after: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.totalCount).toBe(2);
    expect(second.nextCursor).toBeNull();
    const searched = await list(admin, tenantA, {
      q: "dynamic",
      kind: ["CONSOLE"],
    });
    expect(searched.totalCount).toBe(0);
    expect((await list(admin, tenantA, { q: "console" })).totalCount).toBe(2);
  });

  test("a tenant sees its own agents only", async () => {
    expect(idsOf(await list(other, tenantB, { kind: ["DYNAMIC"] }))).toEqual([
      "b-agent",
    ]);
    expect((await list(other, tenantB)).totalCount).toBe(2);
    expect(codeOf(await other(LIST, { tenantId: tenantA }))).toBe("FORBIDDEN");
  });

  test("a viewer lists agents; an unknown kind is refused", async () => {
    expect(
      (await list(viewer, tenantA, { kind: ["DYNAMIC"] })).totalCount,
    ).toBe(1);
    expect(
      codeOf(await admin(LIST, { tenantId: tenantA, kind: ["NOPE"] })),
    ).toBe("BAD_USER_INPUT");
  });
});

describe("client(id) of an agent", () => {
  test("reads a dynamic agent and a metadata-document one, not another tenant's", async () => {
    const dynamic = await admin(GET, { tenantId: tenantA, id: "dynamic-one" });
    expect(dynamic.data?.["client"]).toMatchObject({ registration: "DYNAMIC" });
    const doc = await admin(GET, { tenantId: tenantA, id: DOC });
    expect(doc.data?.["client"]).toMatchObject({
      id: DOC,
      registration: "METADATA",
    });
    expect(
      (await admin(GET, { tenantId: tenantA, id: "b-agent" })).data?.["client"],
    ).toBeNull();
  });

  test("a metadata-document client is read-only: an update finds nothing to change", async () => {
    const result = await admin(UPDATE, {
      tenantId: tenantA,
      id: DOC,
      input: { name: "Renamed" },
    });
    expect(codeOf(result)).toBe("NOT_FOUND");
    expect((await storeOf(tenantA).findClient(DOC))?.name).toBe("Doc agent");
  });
});

describe("a dynamic agent is read-only", () => {
  const ROTATE = `mutation($tenantId: ID!, $id: ID!) { rotateClientSecret(tenantId: $tenantId, id: $id) { clientSecret } }`;
  const EXCHANGE = `mutation($tenantId: ID!, $id: ID!, $input: ClientTokenExchangeInput!) {
    setClientTokenExchange(tenantId: $tenantId, id: $id, input: $input) { id }
  }`;

  test("update, rotate and token exchange answer NOT_FOUND for a janus-style base64url id", async () => {
    // What janus mints for a self-registered client: 43 base64url characters.
    const id = randomBytes(32).toString("base64url");
    await storeOf(tenantA).upsertClient({
      id,
      name: "Self registered",
      redirectUris: [REDIRECT],
      source: "registered",
      createdAt: new Date(),
      expiresAt: null,
    });
    await agentClientsService.record(tenantA, {
      clientId: id,
      kind: "dynamic",
    });
    const calls = [
      admin(UPDATE, { tenantId: tenantA, id, input: { name: "Renamed" } }),
      admin(ROTATE, { tenantId: tenantA, id }),
      admin(EXCHANGE, {
        tenantId: tenantA,
        id,
        input: { targetResources: [], subjectAgents: true },
      }),
    ];
    for (const result of await Promise.all(calls)) {
      expect(codeOf(result)).toBe("NOT_FOUND");
    }
    expect((await storeOf(tenantA).findClient(id))?.name).toBe(
      "Self registered",
    );
  });

  test("a metadata-document agent is refused the same three writes", async () => {
    const id = "https://meta-ro.example/client.json";
    await metadataAgent(tenantA, id);
    const calls = [
      admin(UPDATE, { tenantId: tenantA, id, input: { name: "Renamed" } }),
      admin(ROTATE, { tenantId: tenantA, id }),
      admin(EXCHANGE, {
        tenantId: tenantA,
        id,
        input: { targetResources: [], subjectAgents: true },
      }),
    ];
    for (const result of await Promise.all(calls)) {
      expect(codeOf(result)).toBe("NOT_FOUND");
    }
    expect((await storeOf(tenantA).findClient(id))?.name).toBe("Doc agent");
  });
});

describe("deleteClient of an agent", () => {
  test("removes the client and its agent record, frees the quota, closes its tokens", async () => {
    const id = await dynamicAgent("agc-a", tenantA, "Short lived");
    const store = storeOf(tenantA);
    const now = new Date();
    const later = new Date(now.getTime() + 3_600_000);
    const base = {
      grantId: "agc-grant",
      userId: "user-1",
      clientId: id,
      resource: "https://api.example/v1",
      scopes: ["read"],
      createdAt: now,
      expiresAt: later,
      revokedAt: null,
    };
    await store.upsertGrant({
      id: "agc-grant",
      userId: "user-1",
      clientId: id,
      resource: "https://api.example/v1",
      scopes: ["read"],
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    });
    await store.insertAccessToken({ ...base, tokenHash: "agc-access" });
    await store.insertRefreshToken({
      ...base,
      tokenHash: "agc-refresh",
      absoluteExpiresAt: later,
      rotatedAt: null,
    });
    const before = await usageService.count(tenantA, "agents");
    const result = await admin(DELETE, { tenantId: tenantA, id });
    expect(result.data).toEqual({ deleteClient: true });
    expect(await store.findClient(id)).toBeNull();
    expect(await agentClientsService.has(tenantA, id)).toBe(false);
    expect(await usageService.count(tenantA, "agents")).toBe(before - 1);
    expect((await store.findGrant("agc-grant"))?.revokedAt).toBeInstanceOf(
      Date,
    );
    expect(
      (await store.findAccessToken("agc-access"))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      (await store.findRefreshToken("agc-refresh"))?.revokedAt,
    ).toBeInstanceOf(Date);
    // A repeat answers false and keeps the trail: the event of the first call stays.
    expect((await admin(DELETE, { tenantId: tenantA, id })).data).toEqual({
      deleteClient: false,
    });
    expect(
      await mongo.db.adminEvents.raw.countDocuments({
        action: "client.delete",
        "target.id": id,
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  test("deletes a metadata-document agent too, and its record; another tenant's agent is left", async () => {
    const id = "https://gone.example/client.json";
    await metadataAgent(tenantA, id);
    expect((await admin(DELETE, { tenantId: tenantA, id })).data).toEqual({
      deleteClient: true,
    });
    expect(await storeOf(tenantA).findClient(id)).toBeNull();
    expect(await agentClientsService.has(tenantA, id)).toBe(false);
    // B's agent is unknown under A's id: nothing deleted.
    expect(
      (await admin(DELETE, { tenantId: tenantA, id: "b-agent" })).data,
    ).toEqual({
      deleteClient: false,
    });
    expect(await agentClientsService.has(tenantB, "b-agent")).toBe(true);
  });

  test("a viewer cannot delete an agent", async () => {
    expect(
      codeOf(await viewer(DELETE, { tenantId: tenantA, id: "dynamic-one" })),
    ).toBe("FORBIDDEN");
    expect(await agentClientsService.has(tenantA, "dynamic-one")).toBe(true);
  });

  test("the service tells a metadata client apart: unmanaged unless recorded as an agent", async () => {
    const tenant = {
      _id: tenantOf(tenantA),
      slug: "agc-a",
      status: "active" as const,
    };
    const id = "https://stray.example/client.json";
    await storeOf(tenantA).upsertClient({
      id,
      name: "Stray",
      redirectUris: [REDIRECT],
      source: "metadata",
      createdAt: new Date(),
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    expect(await clientsService.delete(tenant, id)).toEqual({
      removed: false,
      unmanaged: true,
    });
    expect(await storeOf(tenantA).findClient(id)).not.toBeNull();
  });
});
