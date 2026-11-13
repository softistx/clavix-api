import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { ObjectId } from "mongodb";
import { registerClient } from "@/clients/register-client";
import { access, linkTenantToPlatform } from "@/config/access";
import { clientsService } from "@/config/clients";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import { partitionOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { codeOf, consoleAs } from "~/console";
import { createFlow } from "~/oauth-flow";

const REDIRECT = "https://app.example/callback";
const admin = consoleAs("cli-admin-a");
const viewer = consoleAs("cli-viewer-a");
const adminB = consoleAs("cli-admin-b");
const operator = consoleAs("cli-operator");

let tenantA = "";
let tenantB = "";

const CLIENT = "id name type redirectUris grantTypes createdAt";
const CREATE = `mutation($tenantId: ID!, $input: CreateClientInput!) {
  createClient(tenantId: $tenantId, input: $input) { client { ${CLIENT} } clientSecret }
}`;
const UPDATE = `mutation($tenantId: ID!, $id: ID!, $input: UpdateClientInput!) {
  updateClient(tenantId: $tenantId, id: $id, input: $input) { ${CLIENT} }
}`;
const ROTATE = `mutation($tenantId: ID!, $id: ID!) {
  rotateClientSecret(tenantId: $tenantId, id: $id) { client { id } clientSecret }
}`;
const DELETE = `mutation($tenantId: ID!, $id: ID!) { deleteClient(tenantId: $tenantId, id: $id) }`;
const LIST = `query($tenantId: ID!, $q: String, $after: String, $first: Int) {
  clients(tenantId: $tenantId, q: $q, after: $after, first: $first) { items { ${CLIENT} } nextCursor }
}`;
const GET = `query($tenantId: ID!, $id: ID!) { client(tenantId: $tenantId, id: $id) { ${CLIENT} } }`;

const storeOf = async (tenantId: string) => {
  const tenant = await mongo.db.tenants.findById(tenantId);
  if (tenant === undefined) throw new Error("no tenant");
  return createMongoOAuth(oauthDb, { partition: partitionOf(tenant._id) });
};
const create = (
  as: typeof admin,
  tenantId: string,
  input: Record<string, unknown>,
) =>
  as(CREATE, {
    tenantId,
    input: { type: "PUBLIC", redirectUris: [REDIRECT], ...input },
  });
const idsOf = (result: Awaited<ReturnType<typeof admin>>) =>
  (
    result.data?.["clients"] as { items: { id: string }[] } | undefined
  )?.items.map((item) => item.id);

beforeAll(async () => {
  tenantA = (await tenantsService.create({ slug: "cli-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "cli-b", name: "B" })).id;
  await access.grantTenant(tenantA, "cli-admin-a", "admin");
  await access.grantTenant(tenantA, "cli-viewer-a", "viewer");
  await access.grantTenant(tenantB, "cli-admin-b", "admin");
  await access.grantPlatform("cli-operator", "owner");
  // The suite makes more clients than the free plan allows; the quota has its own tests below.
  await mongo.db.tenants.raw.updateMany(
    { slug: { $in: ["cli-a", "cli-b"] } },
    { $set: { quotaOverrides: { clients: 1000 } } },
  );
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.adminEvents.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

describe("createClient", () => {
  test("a confidential client's secret is shown once, and only its hash is kept", async () => {
    const result = await create(admin, tenantA, {
      name: "Back end",
      type: "CONFIDENTIAL",
    });
    expect(result.errors).toBeUndefined();
    const created = result.data?.["createClient"] as {
      client: Record<string, unknown>;
      clientSecret: string;
    };
    expect(created.client).toMatchObject({
      id: "back-end",
      name: "Back end",
      type: "CONFIDENTIAL",
      redirectUris: [REDIRECT],
      grantTypes: ["AUTHORIZATION_CODE", "REFRESH_TOKEN"],
    });
    expect(created.clientSecret.length).toBeGreaterThan(20);
    const stored = await (await storeOf(tenantA)).findClient("back-end");
    expect(stored?.secretHash).toBeDefined();
    expect(stored?.secretHash).not.toBe(created.clientSecret);
    // No field reads a secret back: the type has none.
    const again = await admin(
      `query($tenantId: ID!) { client(tenantId: $tenantId, id: "back-end") { clientSecret } }`,
      { tenantId: tenantA },
    );
    expect(codeOf(again)).toBe("GRAPHQL_VALIDATION_FAILED");
  });

  test("a public client has no secret", async () => {
    const result = await create(admin, tenantA, { name: "Mobile app" });
    expect(result.data?.["createClient"]).toMatchObject({
      client: { id: "mobile-app", type: "PUBLIC" },
      clientSecret: null,
    });
  });

  test("an id already taken is a CONFLICT and changes nothing", async () => {
    const before = await (await storeOf(tenantA)).findClient("back-end");
    const result = await create(admin, tenantA, {
      name: "Another",
      clientId: "back-end",
      type: "CONFIDENTIAL",
    });
    expect(codeOf(result)).toBe("CONFLICT");
    const after = await (await storeOf(tenantA)).findClient("back-end");
    expect(after?.secretHash).toBe(before?.secretHash as string);
    expect(after?.name).toBe("Back end");
  });

  test("bad input is refused", async () => {
    for (const input of [
      { name: " " },
      { name: "X", redirectUris: [] },
      { name: "X", redirectUris: ["not a uri"] },
      { name: "X", clientId: "Not An Id" },
    ]) {
      expect(codeOf(await create(admin, tenantA, input))).toBe(
        "BAD_USER_INPUT",
      );
    }
  });
});

describe("clients and client", () => {
  test("lists in id order in pages, and filters with q", async () => {
    const first = await admin(LIST, { tenantId: tenantA, first: 1 });
    expect(first.errors).toBeUndefined();
    expect(idsOf(first)).toEqual(["back-end"]);
    const page = first.data?.["clients"] as
      | { nextCursor: string | null }
      | undefined;
    const cursor = page?.nextCursor ?? null;
    expect(cursor).not.toBeNull();
    const second = await admin(LIST, {
      tenantId: tenantA,
      first: 1,
      after: cursor,
    });
    expect(idsOf(second)).toEqual(["mobile-app"]);
    expect(idsOf(await admin(LIST, { tenantId: tenantA, q: "MOB" }))).toEqual([
      "mobile-app",
    ]);
    expect(idsOf(await admin(LIST, { tenantId: tenantA, q: ".*" }))).toEqual(
      [],
    );
  });

  test("a search follows the cursor to every match, whatever the page size", async () => {
    const found: string[] = [];
    let after: string | null = null;
    do {
      const result = await admin(LIST, {
        tenantId: tenantA,
        q: "app",
        first: 1,
        after,
      });
      expect(result.errors).toBeUndefined();
      found.push(...(idsOf(result) ?? []));
      after =
        (result.data?.["clients"] as { nextCursor: string | null } | undefined)
          ?.nextCursor ?? null;
    } while (after !== null);
    expect(found).toEqual(["mobile-app"]);
  });

  test("the grant types a script recorded are shown", async () => {
    await registerClient(
      {
        db: oauthDb,
        findTenant: (slug) => mongo.db.tenants.findFirst({ slug }),
      },
      {
        tenant: "cli-a",
        name: "Code only",
        redirectUris: [REDIRECT],
        grants: ["authorization_code"],
      },
    );
    const found = await admin(GET, { tenantId: tenantA, id: "code-only" });
    expect(found.data?.["client"]).toMatchObject({
      grantTypes: ["AUTHORIZATION_CODE"],
    });
    // An update keeps what was recorded.
    const renamed = await admin(UPDATE, {
      tenantId: tenantA,
      id: "code-only",
      input: { name: "Code" },
    });
    expect(renamed.data?.["updateClient"]).toMatchObject({
      name: "Code",
      grantTypes: ["AUTHORIZATION_CODE"],
    });
  });

  test("a client made by the script is listed too", async () => {
    await registerClient(
      {
        db: oauthDb,
        findTenant: (slug) => mongo.db.tenants.findFirst({ slug }),
      },
      { tenant: "cli-a", name: "Scripted", redirectUris: [REDIRECT] },
    );
    expect(
      idsOf(await admin(LIST, { tenantId: tenantA, q: "scripted" })),
    ).toEqual(["scripted"]);
  });

  test("client reads one, null when unknown", async () => {
    const found = await admin(GET, { tenantId: tenantA, id: "mobile-app" });
    expect(found.data?.["client"]).toMatchObject({
      id: "mobile-app",
      name: "Mobile app",
    });
    const none = await admin(GET, { tenantId: tenantA, id: "nobody" });
    expect(none.errors).toBeUndefined();
    expect(none.data?.["client"]).toBeNull();
  });
});

describe("updateClient", () => {
  test("replaces what is given, keeps the type and the secret", async () => {
    const before = await (await storeOf(tenantA)).findClient("back-end");
    const renamed = await admin(UPDATE, {
      tenantId: tenantA,
      id: "back-end",
      input: { name: "API server" },
    });
    expect(renamed.data?.["updateClient"]).toMatchObject({
      id: "back-end",
      name: "API server",
      type: "CONFIDENTIAL",
      redirectUris: [REDIRECT],
    });
    const moved = await admin(UPDATE, {
      tenantId: tenantA,
      id: "back-end",
      input: { redirectUris: ["https://app.example/cb2"] },
    });
    expect(moved.data?.["updateClient"]).toMatchObject({
      name: "API server",
      redirectUris: ["https://app.example/cb2"],
    });
    const after = await (await storeOf(tenantA)).findClient("back-end");
    expect(after?.secretHash).toBe(before?.secretHash as string);
    expect(after?.createdAt).toEqual(before?.createdAt as Date);
    // The list follows.
    expect(idsOf(await admin(LIST, { tenantId: tenantA, q: "API" }))).toEqual([
      "back-end",
    ]);
  });

  test("an unknown client is NOT_FOUND, a bad redirect URI is refused", async () => {
    expect(
      codeOf(
        await admin(UPDATE, {
          tenantId: tenantA,
          id: "nobody",
          input: { name: "X" },
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      codeOf(
        await admin(UPDATE, {
          tenantId: tenantA,
          id: "back-end",
          input: { redirectUris: [] },
        }),
      ),
    ).toBe("BAD_USER_INPUT");
  });
});

describe("rotateClientSecret", () => {
  test("mints a new secret, shown once; the old hash is gone", async () => {
    const before = await (await storeOf(tenantA)).findClient("back-end");
    const result = await admin(ROTATE, { tenantId: tenantA, id: "back-end" });
    expect(result.errors).toBeUndefined();
    const rotated = result.data?.["rotateClientSecret"] as {
      clientSecret: string;
    };
    expect(rotated.clientSecret.length).toBeGreaterThan(20);
    const after = await (await storeOf(tenantA)).findClient("back-end");
    expect(after?.secretHash).toBeDefined();
    expect(after?.secretHash).not.toBe(before?.secretHash as string);
  });

  test("a public client has none to rotate; an unknown one is NOT_FOUND", async () => {
    expect(
      codeOf(await admin(ROTATE, { tenantId: tenantA, id: "mobile-app" })),
    ).toBe("BAD_USER_INPUT");
    expect(
      codeOf(await admin(ROTATE, { tenantId: tenantA, id: "nobody" })),
    ).toBe("NOT_FOUND");
  });
});

describe("permissions and isolation", () => {
  test("a viewer reads but changes nothing", async () => {
    expect(idsOf(await viewer(LIST, { tenantId: tenantA }))).toContain(
      "back-end",
    );
    expect(
      (await viewer(GET, { tenantId: tenantA, id: "back-end" })).data?.[
        "client"
      ],
    ).toMatchObject({ id: "back-end" });
    const refused = [
      await create(viewer, tenantA, { name: "Nope" }),
      await viewer(UPDATE, {
        tenantId: tenantA,
        id: "back-end",
        input: { name: "Nope" },
      }),
      await viewer(ROTATE, { tenantId: tenantA, id: "back-end" }),
      await viewer(DELETE, { tenantId: tenantA, id: "back-end" }),
    ];
    expect(refused.map(codeOf)).toEqual(Array(4).fill("FORBIDDEN"));
    expect((await (await storeOf(tenantA)).findClient("back-end"))?.name).toBe(
      "API server",
    );
  });

  test("tenant A's admin cannot touch tenant B", async () => {
    await create(adminB, tenantB, { name: "B app", type: "CONFIDENTIAL" });
    const refused = [
      await admin(LIST, { tenantId: tenantB }),
      await admin(GET, { tenantId: tenantB, id: "b-app" }),
      await create(admin, tenantB, { name: "Nope" }),
      await admin(UPDATE, {
        tenantId: tenantB,
        id: "b-app",
        input: { name: "Nope" },
      }),
      await admin(ROTATE, { tenantId: tenantB, id: "b-app" }),
      await admin(DELETE, { tenantId: tenantB, id: "b-app" }),
    ];
    expect(refused.map(codeOf)).toEqual(Array(6).fill("FORBIDDEN"));
  });

  test("a client of B is unknown under A's id", async () => {
    expect(idsOf(await admin(LIST, { tenantId: tenantA }))).not.toContain(
      "b-app",
    );
    expect(idsOf(await adminB(LIST, { tenantId: tenantB }))).toEqual(["b-app"]);
    expect(
      (await admin(GET, { tenantId: tenantA, id: "b-app" })).data?.["client"],
    ).toBeNull();
    expect(
      codeOf(await admin(ROTATE, { tenantId: tenantA, id: "b-app" })),
    ).toBe("NOT_FOUND");
    expect(
      (await admin(DELETE, { tenantId: tenantA, id: "b-app" })).data?.[
        "deleteClient"
      ],
    ).toBe(false);
    expect(await (await storeOf(tenantB)).findClient("b-app")).not.toBeNull();
    // The same id may exist in both tenants.
    expect(
      (await create(admin, tenantA, { name: "B app" })).errors,
    ).toBeUndefined();
    expect(
      (await (await storeOf(tenantB)).findClient("b-app"))?.secretHash,
    ).toBeDefined();
  });

  test("a platform owner reaches every tenant; an unknown id is refused", async () => {
    expect(idsOf(await operator(LIST, { tenantId: tenantB }))).toEqual([
      "b-app",
    ]);
    for (const tenantId of ["0123456789abcdef01234567", "nope"]) {
      expect(codeOf(await operator(LIST, { tenantId }))).toBe("FORBIDDEN");
    }
  });
});

describe("deleteClient", () => {
  test("deletes once, then answers false", async () => {
    const first = await admin(DELETE, { tenantId: tenantA, id: "mobile-app" });
    expect(first.data?.["deleteClient"]).toBe(true);
    expect(await (await storeOf(tenantA)).findClient("mobile-app")).toBeNull();
    expect(idsOf(await admin(LIST, { tenantId: tenantA }))).not.toContain(
      "mobile-app",
    );
    const second = await admin(DELETE, {
      tenantId: tenantA,
      id: "mobile-app",
    });
    expect(second.errors).toBeUndefined();
    expect(second.data?.["deleteClient"]).toBe(false);
  });

  test("revokes the client's grants, on a repeat too, and no other client's", async () => {
    const store = await storeOf(tenantA);
    const grant = (id: string, clientId: string) =>
      store.upsertGrant({
        id,
        userId: "user-1",
        clientId,
        resource: "https://api.example/v1",
        scopes: ["read"],
        createdAt: new Date(),
        updatedAt: new Date(),
        revokedAt: null,
      });
    const gone = await grant("grant-code-only", "code-only");
    const kept = await grant("grant-back-end", "back-end");
    const result = await admin(DELETE, { tenantId: tenantA, id: "code-only" });
    expect(result.data?.["deleteClient"]).toBe(true);
    expect((await store.findGrant(gone.id))?.revokedAt).toBeInstanceOf(Date);
    expect((await store.findGrant(kept.id))?.revokedAt).toBeNull();
    // A repeat revokes again: it finishes a run that stopped half way.
    const late = await grant("grant-code-only-late", "code-only");
    const again = await admin(DELETE, { tenantId: tenantA, id: "code-only" });
    expect(again.data?.["deleteClient"]).toBe(false);
    expect((await store.findGrant(late.id))?.revokedAt).toBeInstanceOf(Date);
  });
});

describe("limits", () => {
  test("a refused creation leaves nothing listed, and the id stays free", async () => {
    const bad = await create(admin, tenantA, {
      name: "Ghost",
      redirectUris: ["not a uri"],
    });
    expect(codeOf(bad)).toBe("BAD_USER_INPUT");
    expect(idsOf(await admin(LIST, { tenantId: tenantA, q: "ghost" }))).toEqual(
      [],
    );
    expect(
      (await create(admin, tenantA, { name: "Ghost" })).errors,
    ).toBeUndefined();
  });

  test("the list and the detail give the same creation date", async () => {
    const listed = await admin(LIST, { tenantId: tenantA, q: "ghost" });
    const [item] = (
      (listed.data?.["clients"] ?? { items: [] }) as {
        items: Record<string, unknown>[];
      }
    ).items;
    const got = await admin(GET, { tenantId: tenantA, id: "ghost" });
    expect(item).toEqual(got.data?.["client"] as Record<string, unknown>);
  });

  test("a cursor, a name or a list too long are BAD_USER_INPUT", async () => {
    expect(
      codeOf(await admin(LIST, { tenantId: tenantA, after: "c".repeat(201) })),
    ).toBe("BAD_USER_INPUT");
    expect(
      codeOf(await create(admin, tenantA, { name: "n".repeat(101) })),
    ).toBe("BAD_USER_INPUT");
    const uris = Array.from({ length: 21 }, (_, i) => `${REDIRECT}/${i}`);
    expect(
      codeOf(
        await create(admin, tenantA, { name: "Many", redirectUris: uris }),
      ),
    ).toBe("BAD_USER_INPUT");
  });
});

describe("the console's own client", () => {
  test("cannot be changed, rotated or deleted here, even by a platform owner", async () => {
    const platform = await mongo.db.tenants.findFirst({
      slug: PLATFORM_TENANT_SLUG,
    });
    const tenantId = platform?._id.toHexString() ?? "";
    // The specs empty the relations: link the tenant again, as the migration does.
    await linkTenantToPlatform(tenantId);
    const id = "console";
    expect(
      codeOf(await operator(UPDATE, { tenantId, id, input: { name: "X" } })),
    ).toBe("BAD_USER_INPUT");
    expect(codeOf(await operator(ROTATE, { tenantId, id }))).toBe(
      "BAD_USER_INPUT",
    );
    expect(codeOf(await operator(DELETE, { tenantId, id }))).toBe(
      "BAD_USER_INPUT",
    );
    // Another tenant's client of that id is an ordinary client.
    await create(admin, tenantA, { name: "Console", clientId: "console" });
    const deleted = await admin(DELETE, { tenantId: tenantA, id });
    expect(deleted.data?.["deleteClient"]).toBe(true);
  });
});

describe("admin events", () => {
  test("each mutation records its event on the client, and never the secret", async () => {
    await mongo.db.adminEvents.raw.deleteMany({});
    const created = await create(admin, tenantA, {
      name: "Audited",
      type: "CONFIDENTIAL",
    });
    const clientSecret = String(
      (created.data?.["createClient"] as Record<string, unknown> | undefined)?.[
        "clientSecret"
      ],
    );
    expect(clientSecret.length).toBeGreaterThan(20);
    const id = "audited";
    await admin(UPDATE, {
      tenantId: tenantA,
      id,
      input: { name: "Audited 2" },
    });
    const rotated = await admin(ROTATE, { tenantId: tenantA, id });
    const second = String(
      (
        rotated.data?.["rotateClientSecret"] as
          | Record<string, unknown>
          | undefined
      )?.["clientSecret"],
    );
    expect(second.length).toBeGreaterThan(20);
    await admin(DELETE, { tenantId: tenantA, id });
    await admin(DELETE, { tenantId: tenantA, id });
    // A refused mutation records nothing.
    await viewer(DELETE, { tenantId: tenantA, id });
    await admin(UPDATE, { tenantId: tenantA, id, input: { name: "Gone" } });
    const events = await mongo.db.adminEvents.raw
      .find({})
      .sort({ _id: 1 })
      .toArray();
    expect(events.map((event) => event.action)).toEqual([
      "client.create",
      "client.update",
      "client.rotateSecret",
      "client.delete",
      "client.delete",
    ]);
    for (const event of events) {
      expect(event.actor).toBe("cli-admin-a");
      expect(event.target).toEqual({ type: "client", id });
      expect(event.tenantId?.toHexString()).toBe(tenantA);
    }
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(clientSecret);
    expect(dump).not.toContain(second);
  });
});

describe("a suspended tenant", () => {
  test("is readable, and its writes are TENANT_SUSPENDED for its admin", async () => {
    await tenantsService.suspend(tenantB);
    expect((await adminB(LIST, { tenantId: tenantB })).errors).toBeUndefined();
    expect(
      (await operator(LIST, { tenantId: tenantB })).errors,
    ).toBeUndefined();
    expect(codeOf(await create(adminB, tenantB, { name: "Nope" }))).toBe(
      "TENANT_SUSPENDED",
    );
  });
});

const eventsOf = () =>
  mongo.db.adminEvents.raw.find({}).sort({ _id: 1 }).toArray();

describe("createClient of one id at the very same time", () => {
  test("exactly one wins, the others are CONFLICT, and the winner's secret is the stored one", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        create(admin, tenantA, {
          name: "Racer",
          clientId: "racer",
          type: "CONFIDENTIAL",
        }),
      ),
    );
    const winners = results.filter((r) => r.errors === undefined);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => codeOf(r) === "CONFLICT")).toHaveLength(7);
    expect(idsOf(await admin(LIST, { tenantId: tenantA, q: "racer" }))).toEqual(
      ["racer"],
    );
    // The stored secret is the winner's: rotating is the only way to another.
    const winner = winners[0]?.data?.["createClient"] as {
      clientSecret: string;
    };
    const stored = await (await storeOf(tenantA)).findClient("racer");
    expect(stored?.secretHash).toBeString();
    expect(winner.clientSecret.length).toBeGreaterThan(20);
  });
});

describe("the client quota", () => {
  test("refuses past the limit, counts concurrent creations, frees a slot on delete", async () => {
    const id = (await tenantsService.create({ slug: "cli-q", name: "Q" })).id;
    await access.grantTenant(id, "cli-admin-a", "admin");
    const used = await usageService.count(id, "clients");
    await mongo.db.tenants.raw.updateOne(
      { _id: new ObjectId(id) },
      { $set: { quotaOverrides: { clients: used + 2 } } },
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, n) =>
        create(admin, id, { name: `Q ${n}`, clientId: `quota-${n}` }),
      ),
    );
    expect(results.filter((r) => r.errors === undefined)).toHaveLength(2);
    expect(results.filter((r) => codeOf(r) === "QUOTA_EXCEEDED")).toHaveLength(
      3,
    );
    const kept = results.findIndex((r) => r.errors === undefined);
    expect(
      codeOf(await create(admin, id, { name: "More", clientId: "more" })),
    ).toBe("QUOTA_EXCEEDED");
    expect(
      (await admin(DELETE, { tenantId: id, id: `quota-${kept}` })).data,
    ).toEqual({ deleteClient: true });
    expect(
      (await create(admin, id, { name: "Fits", clientId: "fits" })).errors,
    ).toBeUndefined();
  });
});

describe("the deleteClient trail", () => {
  test("a client that is not a registered one is left alone and not recorded", async () => {
    const store = await storeOf(tenantA);
    await create(admin, tenantA, { name: "By script", clientId: "by-script" });
    const record = await store.findClient("by-script");
    // A record the console did not register (here from a client metadata document).
    await store.upsertClient({
      ...(record as NonNullable<typeof record>),
      source: "metadata",
    });
    await mongo.db.adminEvents.raw.deleteMany({});
    const result = await admin(DELETE, { tenantId: tenantA, id: "by-script" });
    expect(result.data).toEqual({ deleteClient: false });
    expect(
      await (await storeOf(tenantA)).findClient("by-script"),
    ).not.toBeNull();
    expect(await eventsOf()).toHaveLength(0);
  });

  test("the service answers from one read: unmanaged, removed, then absent", async () => {
    const store = await storeOf(tenantA);
    const tenant = {
      _id: new ObjectId(tenantA),
      slug: "cli-a",
      status: "active",
    } as const;
    await create(admin, tenantA, { name: "One read", clientId: "one-read" });
    const record = await store.findClient("one-read");
    await store.upsertClient({
      ...(record as NonNullable<typeof record>),
      source: "metadata",
    });
    expect(await clientsService.delete(tenant, "one-read")).toEqual({
      removed: false,
      unmanaged: true,
    });
    await store.upsertClient({
      ...(record as NonNullable<typeof record>),
      source: "registered",
    });
    expect(await clientsService.delete(tenant, "one-read")).toEqual({
      removed: true,
      unmanaged: false,
    });
    expect(await clientsService.delete(tenant, "one-read")).toEqual({
      removed: false,
      unmanaged: false,
    });
  });

  test("a registered client, and a valid id that names nothing, are recorded", async () => {
    await mongo.db.adminEvents.raw.deleteMany({});
    await create(admin, tenantA, { name: "Trail", clientId: "trail" });
    await admin(DELETE, { tenantId: tenantA, id: "trail" });
    await admin(DELETE, { tenantId: tenantA, id: "trail" });
    await admin(DELETE, { tenantId: tenantA, id: "never-existed" });
    // An id no client can have names nothing.
    await admin(DELETE, { tenantId: tenantA, id: "Not An Id!" });
    expect((await eventsOf()).map((e) => [e.action, e.target.id])).toEqual([
      ["client.create", "trail"],
      ["client.delete", "trail"],
      ["client.delete", "trail"],
      ["client.delete", "never-existed"],
    ]);
  });
});

describe("the tokens of a deleted client", () => {
  test("stop working: the access token, and the refresh token", async () => {
    const flow = createFlow();
    const { tenantId } = await flow.setUp("cli-tok", [
      "https://api.cli-tok.example/v1",
    ]);
    await access.grantTenant(tenantId, "cli-admin-a", "admin");
    const created = await create(admin, tenantId, {
      name: "Token app",
      clientId: "token-app",
      type: "CONFIDENTIAL",
    });
    const secret = (
      (created.data?.["createClient"] ?? {}) as { clientSecret: string }
    ).clientSecret;
    const client = { id: "token-app", secret };
    const tokens = await flow.tokensOf("cli-tok", "openid", {
      client,
    });
    const userinfo = (token: string) =>
      flow.get("cli-tok", "/userinfo", `Bearer ${token}`);
    const refresh = (token: string) =>
      flow.post(
        "cli-tok",
        "/token",
        { grant_type: "refresh_token", refresh_token: token },
        flow.basic(client.id, client.secret),
      );
    expect(tokens.refresh_token).toBeString();
    const before = await refresh(tokens.refresh_token ?? "");
    expect(before.status).toBe(200);
    const live = (await before.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect((await userinfo(live.access_token)).status).toBe(200);

    expect((await admin(DELETE, { tenantId, id: "token-app" })).data).toEqual({
      deleteClient: true,
    });

    expect((await userinfo(live.access_token)).status).toBe(401);
    const after = await refresh(live.refresh_token);
    expect(after.status).toBeGreaterThanOrEqual(400);
    // The client itself no longer authenticates either.
    const code = await flow
      .login("cli-tok", "openid", { client })
      .catch(() => null);
    expect(code === null || code.status >= 400).toBe(true);
  });
});

describe("update and rotate of a client that is being deleted", () => {
  test("a missing client is NOT_FOUND, never created by the write", async () => {
    const id = "never-registered";
    expect(
      codeOf(
        await admin(UPDATE, { tenantId: tenantA, id, input: { name: "X" } }),
      ),
    ).toBe("NOT_FOUND");
    expect(codeOf(await admin(ROTATE, { tenantId: tenantA, id }))).toBe(
      "NOT_FOUND",
    );
    expect(await (await storeOf(tenantA)).findClient(id)).toBeNull();
  });

  test("a racing delete is never undone: the client stays deleted", async () => {
    for (let round = 0; round < 10; round++) {
      const id = `undead-${round}`;
      await create(admin, tenantA, {
        name: id,
        clientId: id,
        type: "CONFIDENTIAL",
      });
      const results = await Promise.all([
        admin(UPDATE, { tenantId: tenantA, id, input: { name: "Renamed" } }),
        admin(ROTATE, { tenantId: tenantA, id }),
        admin(DELETE, { tenantId: tenantA, id }),
        admin(UPDATE, { tenantId: tenantA, id, input: { name: "Again" } }),
      ]);
      // Serialized, a write either ran before the delete or found no client.
      for (const result of results.slice(0, 2).concat(results.slice(3))) {
        if (result.errors !== undefined) {
          expect(codeOf(result)).toBe("NOT_FOUND");
        }
      }
      expect(await (await storeOf(tenantA)).findClient(id)).toBeNull();
    }
  });
});

describe("the tenant id's spelling", () => {
  test("an upper-case tenant id is the same tenant, as on every module", async () => {
    const lower = await admin(LIST, { tenantId: tenantA });
    const upper = await admin(LIST, { tenantId: tenantA.toUpperCase() });
    expect(upper.errors).toBeUndefined();
    expect(upper.data).toEqual(lower.data);
  });
});
