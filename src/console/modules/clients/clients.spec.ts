import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { registerClient } from "@/clients/register-client";
import { access } from "@/config/access";
import { clientIndex } from "@/config/clients";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { partitionOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { codeOf, consoleAs } from "~/console";

const REDIRECT = "https://app.example/callback";
const admin = consoleAs("cli-admin-a");
const viewer = consoleAs("cli-viewer-a");
const adminB = consoleAs("cli-admin-b");
const operator = consoleAs("cli-operator");

let tenantA = "";
let tenantB = "";

const CLIENT = "id name type redirectUris createdAt";
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
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.clientIndex.raw.deleteMany({});
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
  test("lists by name in pages, and filters with q", async () => {
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

  test("a client made by the script is listed too", async () => {
    await registerClient(
      {
        db: oauthDb,
        findTenant: (slug) => mongo.db.tenants.findFirst({ slug }),
        index: clientIndex,
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
});

describe("a suspended tenant", () => {
  test("is NOT_FOUND, even for its admin and a platform owner", async () => {
    await tenantsService.suspend(tenantB);
    expect(codeOf(await adminB(LIST, { tenantId: tenantB }))).toBe("NOT_FOUND");
    expect(codeOf(await operator(LIST, { tenantId: tenantB }))).toBe(
      "NOT_FOUND",
    );
    expect(codeOf(await create(adminB, tenantB, { name: "Nope" }))).toBe(
      "NOT_FOUND",
    );
  });
});
