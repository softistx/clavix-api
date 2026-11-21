import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { access } from "@/config/access";
import { clientsService } from "@/config/clients";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { resourcesFor } from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { fingerprintOf } from "@/oauth/resolution";
import { at } from "~/body";
import { codeOf, consoleAs } from "~/console";
import { oneRow as one, recordsOf, rowsOf, textOf } from "~/rows";

const API = "https://api.dt-a.example/v1";
const admin = consoleAs("dt-admin-a");
const viewer = consoleAs("dt-viewer-a");
const adminB = consoleAs("dt-admin-b");

let tenantA = "";
let tenantB = "";
let resourceA = "";
let resourceA2 = "";
let resourceB = "";

const TEXT = "fr en";
const TYPE = `id resourceId type name { ${TEXT} } description { ${TEXT} } createdAt updatedAt
  fields { key kind label { ${TEXT} } required min max maxLength values { value label { ${TEXT} } } }
  actions { value label { ${TEXT} } }`;
const CREATE = `mutation($tenantId: ID!, $input: CreateDetailTypeInput!) {
  createDetailType(tenantId: $tenantId, input: $input) { ${TYPE} }
}`;
const UPDATE = `mutation($tenantId: ID!, $id: ID!, $input: UpdateDetailTypeInput!) {
  updateDetailType(tenantId: $tenantId, id: $id, input: $input) { ${TYPE} }
}`;
const DELETE = `mutation($tenantId: ID!, $id: ID!) { deleteDetailType(tenantId: $tenantId, id: $id) }`;
const DELETE_RESOURCE = `mutation($tenantId: ID!, $id: ID!) { deleteResource(tenantId: $tenantId, id: $id) }`;
const CREATE_RESOURCE = `mutation($tenantId: ID!, $input: CreateResourceInput!) {
  createResource(tenantId: $tenantId, input: $input) { id }
}`;
const RESOURCE = `query($tenantId: ID!, $id: ID!) {
  resource(tenantId: $tenantId, id: $id) { id detailTypes { id type } }
}`;
const LIST = `query($tenantId: ID!) { resources(tenantId: $tenantId) { id detailTypes { type } } }`;

const text = (en: string) => ({ fr: en, en });
const payment = (extra: Record<string, unknown> = {}) => ({
  resourceId: resourceA,
  type: "payment",
  name: { fr: "Paiement", en: "Payment" },
  description: { fr: "Payer", en: "Pay someone" },
  fields: [
    {
      key: "amount",
      kind: "NUMBER",
      label: text("Amount"),
      required: true,
      min: 0.01,
      max: 1000,
    },
    {
      key: "currency",
      kind: "ENUM",
      label: text("Currency"),
      required: true,
      values: [{ value: "EUR", label: text("Euro") }],
    },
    { key: "tags", kind: "STRING_LIST", max: 4, maxLength: 20 },
  ],
  actions: [{ value: "initiate", label: text("Start") }],
  ...extra,
});

const created = async (
  as: typeof admin,
  tenantId: string,
  input: Record<string, unknown>,
) => one(await as(CREATE, { tenantId, input }), "createDetailType");

const servedTypes = async (slug: string, uri: string) => {
  const tenant = await tenantResolver.resolveHost(
    `${slug}.${env.CLAVIX_DOMAIN}`,
  );
  if (tenant === null) throw new Error("tenant not resolved");
  return Object.keys(
    (await resourcesFor(tenant))[uri]?.authorizationDetails ?? {},
  );
};

/** Makes the client list these types (R3 will do it through the console). */
async function clientListing(tenantId: string, types: string[]) {
  const tenant = {
    _id: new ObjectId(tenantId),
    slug: "dt-a",
    status: "active",
  } as const;
  await clientsService.create(tenant, {
    name: "Back office",
    type: "confidential",
    redirectUris: ["https://office.example/cb"],
    clientId: "dt-client",
  });
  const store = createMongoOAuth(oauthDb, { partition: tenantId });
  const record = await store.findClient("dt-client");
  if (record === null) throw new Error("no client");
  await store.upsertClient({ ...record, authorizationDetailsTypes: types });
}
const listed = async (tenantId: string) =>
  (
    await createMongoOAuth(oauthDb, { partition: tenantId }).findClient(
      "dt-client",
    )
  )?.authorizationDetailsTypes;

const actions = async () =>
  (await mongo.db.adminEvents.raw.find({}).toArray()).map((e) => e["action"]);

beforeAll(async () => {
  tenantA = (await tenantsService.create({ slug: "dt-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "dt-b", name: "B" })).id;
  await access.grantTenant(tenantA, "dt-admin-a", "admin");
  await access.grantTenant(tenantA, "dt-viewer-a", "viewer");
  await access.grantTenant(tenantB, "dt-admin-b", "admin");
  resourceA = one(
    await admin(CREATE_RESOURCE, { tenantId: tenantA, input: { uri: API } }),
    "createResource",
  ).id;
  resourceA2 = one(
    await admin(CREATE_RESOURCE, {
      tenantId: tenantA,
      input: { uri: "https://billing.dt-a.example/" },
    }),
    "createResource",
  ).id;
  resourceB = one(
    await adminB(CREATE_RESOURCE, { tenantId: tenantB, input: { uri: API } }),
    "createResource",
  ).id;
});

afterAll(async () => {
  for (const tenantId of [tenantA, tenantB]) {
    await mongo.db.resources.raw.deleteMany({
      tenantId: new ObjectId(tenantId),
    });
    await mongo.db.scopes.raw.deleteMany({ tenantId: new ObjectId(tenantId) });
    await mongo.db.detailTypes.raw.deleteMany({
      tenantId: new ObjectId(tenantId),
    });
    await oauthDb
      .collection("oauthPartitionedClients")
      .deleteMany({ partition: tenantId });
  }
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await oauthDb.collection("relations").deleteMany({});
});

describe("createDetailType", () => {
  test("stores the type, lists it on its resource and serves it at once", async () => {
    await mongo.db.adminEvents.raw.deleteMany({});
    const before = await servedFingerprint();
    const type = await created(admin, tenantA, payment());
    expect(type).toMatchObject({
      resourceId: resourceA,
      type: "payment",
      name: { fr: "Paiement", en: "Payment" },
      actions: [{ value: "initiate", label: text("Start") }],
    });
    expect(recordsOf(type["fields"]).map((f) => f["kind"])).toEqual([
      "NUMBER",
      "ENUM",
      "STRING_LIST",
    ]);
    expect(recordsOf(type["fields"])[2]).toMatchObject({
      required: false,
      max: 4,
      maxLength: 20,
      values: null,
    });
    const read = one(
      await admin(RESOURCE, { tenantId: tenantA, id: resourceA }),
      "resource",
    );
    expect(read["detailTypes"]).toMatchObject([
      { id: type.id, type: "payment" },
    ]);
    expect(await servedTypes("dt-a", API)).toEqual(["payment"]);
    expect(await actions()).toEqual(["detailType.create"]);
    expect(await servedFingerprint()).not.toBe(before);
  });

  test("the same values twice on the same resource give the same record and record the event again", async () => {
    const before = await actions();
    const again = one(
      await admin(CREATE, { tenantId: tenantA, input: payment() }),
      "createDetailType",
    );
    const existing = at(
      (await admin(RESOURCE, { tenantId: tenantA, id: resourceA })).data,
      "resource",
      z.object({
        detailTypes: z.array(z.object({ id: z.string(), type: z.string() })),
      }),
    );
    expect(existing.detailTypes.filter((t) => t.type === "payment")).toEqual([
      { id: again.id, type: "payment" },
    ]);
    expect(await actions()).toEqual([...before, "detailType.create"]);
  });

  test("a name the tenant already has is a CONFLICT with other values, or on another resource (D2)", async () => {
    expect(
      codeOf(
        await admin(CREATE, {
          tenantId: tenantA,
          input: payment({ name: { fr: "Autre", en: "Other" } }),
        }),
      ),
    ).toBe("CONFLICT");
    expect(
      codeOf(
        await admin(CREATE, {
          tenantId: tenantA,
          input: payment({ resourceId: resourceA2 }),
        }),
      ),
    ).toBe("CONFLICT");
    // Another tenant is free to use the name.
    await created(adminB, tenantB, payment({ resourceId: resourceB }));
  });

  test("an invalid definition is BAD_USER_INPUT and nothing is stored", async () => {
    const fields = Array.from({ length: 17 }, (_, i) => ({
      key: `f${i}`,
      kind: "BOOLEAN",
    }));
    const attempts: Record<string, unknown>[] = [
      payment({ type: "two words" }),
      payment({ type: "x".repeat(65) }),
      payment({ type: "no-name", name: {} }),
      payment({ type: "many", fields }),
      payment({
        type: "reserved",
        fields: [{ key: "locations", kind: "STRING" }],
      }),
      payment({
        type: "twice",
        fields: [
          { key: "a", kind: "STRING" },
          { key: "a", kind: "STRING" },
        ],
      }),
      payment({ type: "empty-enum", fields: [{ key: "a", kind: "ENUM" }] }),
      payment({
        type: "bad-bound",
        fields: [{ key: "a", kind: "STRING", min: 1 }],
      }),
    ];
    for (const input of attempts) {
      expect(codeOf(await admin(CREATE, { tenantId: tenantA, input }))).toBe(
        "BAD_USER_INPUT",
      );
    }
    expect(await servedTypes("dt-a", API)).toEqual(["payment"]);
  });

  test("labels and descriptions are bounded", async () => {
    const long = (n: number) => "x".repeat(n);
    const attempts: Record<string, unknown>[] = [
      payment({ type: "long-name", name: { en: long(101) } }),
      payment({ type: "long-desc", description: { fr: long(301) } }),
      payment({
        type: "long-field",
        fields: [{ key: "a", kind: "STRING", label: { en: long(101) } }],
      }),
      payment({
        type: "long-value",
        fields: [
          {
            key: "a",
            kind: "ENUM",
            values: [{ value: "v", label: { fr: long(101) } }],
          },
        ],
      }),
      payment({
        type: "long-action",
        actions: [{ value: "a", label: { en: long(101) } }],
      }),
    ];
    for (const input of attempts) {
      expect(codeOf(await admin(CREATE, { tenantId: tenantA, input }))).toBe(
        "BAD_USER_INPUT",
      );
    }
    // At the limit it is accepted.
    await created(
      admin,
      tenantA,
      payment({
        type: "at-limit",
        name: { en: long(100) },
        description: { en: long(300) },
      }),
    );
  });

  test("the resource must be the tenant's own: another tenant's is NOT_FOUND", async () => {
    expect(
      codeOf(
        await adminB(CREATE, {
          tenantId: tenantB,
          input: payment({ type: "stolen", resourceId: resourceA }),
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      codeOf(
        await admin(CREATE, {
          tenantId: tenantA,
          input: payment({
            type: "ghost",
            resourceId: "0123456789abcdef01234567",
          }),
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      codeOf(
        await admin(CREATE, {
          tenantId: tenantA,
          input: payment({ type: "bad-id", resourceId: "nope" }),
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await mongo.db.detailTypes.raw.countDocuments({
        type: { $in: ["stolen", "ghost", "bad-id"] },
      }),
    ).toBe(0);
  });
});

async function listIdOf(type: string) {
  const doc = await mongo.db.detailTypes.raw.findOne({
    type,
    tenantId: new ObjectId(tenantA),
  });
  return doc?._id.toHexString() ?? "";
}

describe("updateDetailType", () => {
  test("changes the texts and fields, never the type name", async () => {
    const id = await listIdOf("payment");
    await mongo.db.adminEvents.raw.deleteMany({});
    const before = await servedFingerprint();
    const updated = one(
      await admin(UPDATE, {
        tenantId: tenantA,
        id,
        input: {
          name: { en: "Payment order" },
          fields: [{ key: "amount", kind: "INTEGER", required: true, min: 1 }],
          actions: [],
        },
      }),
      "updateDetailType",
    );
    expect(updated).toMatchObject({
      id,
      type: "payment",
      name: { fr: "Paiement", en: "Payment order" },
      description: { fr: "Payer", en: "Pay someone" },
      actions: [],
    });
    expect(updated["fields"]).toMatchObject([
      { key: "amount", kind: "INTEGER", required: true, min: 1 },
    ]);
    expect(await servedFingerprint()).not.toBe(before);
    expect(await actions()).toEqual(["detailType.update"]);
  });

  test("nothing is written when nothing changes", async () => {
    const id = await listIdOf("payment");
    const first = one(
      await admin(UPDATE, { tenantId: tenantA, id, input: {} }),
      "updateDetailType",
    );
    const same = one(
      await admin(UPDATE, {
        tenantId: tenantA,
        id,
        input: {
          name: { en: "Payment order" },
          fields: [{ key: "amount", kind: "INTEGER", required: true, min: 1 }],
        },
      }),
      "updateDetailType",
    );
    expect(same["updatedAt"]).toBe(first["updatedAt"]);
    const raw = await mongo.db.detailTypes.raw.findOne({
      _id: new ObjectId(id),
    });
    expect(raw?.updatedAt.toISOString()).toBe(textOf(first["updatedAt"]));
  });

  test("an invalid change or a long label is BAD_USER_INPUT; an unknown id is NOT_FOUND", async () => {
    const id = await listIdOf("payment");
    for (const input of [
      { fields: [{ key: "type", kind: "STRING" }] },
      { description: { en: "x".repeat(301) } },
      { name: { fr: "x".repeat(101) } },
    ]) {
      expect(
        codeOf(await admin(UPDATE, { tenantId: tenantA, id, input })),
      ).toBe("BAD_USER_INPUT");
    }
    for (const bad of ["0123456789abcdef01234567", "nope"]) {
      expect(
        codeOf(await admin(UPDATE, { tenantId: tenantA, id: bad, input: {} })),
      ).toBe("NOT_FOUND");
    }
  });
});

describe("deleting (D6)", () => {
  test("a type a client lists cannot be deleted: DETAIL_TYPE_IN_USE", async () => {
    await clientListing(tenantA, ["payment"]);
    const id = await listIdOf("payment");
    await mongo.db.adminEvents.raw.deleteMany({});
    const result = await admin(DELETE, { tenantId: tenantA, id });
    expect(codeOf(result)).toBe("DETAIL_TYPE_IN_USE");
    expect(result.errors?.[0]?.message).toContain("payment");
    expect(await servedTypes("dt-a", API)).toContain("payment");
    expect(await actions()).toEqual([]);
  });

  test("once no client lists it, it is deleted, then false", async () => {
    await clientListing(tenantA, []);
    const id = await listIdOf("payment");
    expect(
      (await admin(DELETE, { tenantId: tenantA, id })).data?.[
        "deleteDetailType"
      ],
    ).toBe(true);
    expect(
      (await admin(DELETE, { tenantId: tenantA, id })).data?.[
        "deleteDetailType"
      ],
    ).toBe(false);
    expect(await servedTypes("dt-a", API)).not.toContain("payment");
    expect(await actions()).toContain("detailType.delete");
  });

  test("another client's list of the same name in another tenant does not block", async () => {
    // Tenant B keeps its own "payment"; tenant A's is free to go once re-created and unlisted.
    await created(admin, tenantA, payment({ type: "refund" }));
    const stray = createMongoOAuth(oauthDb, { partition: tenantB });
    await stray.upsertClient({
      id: "other",
      name: "Other",
      redirectUris: ["https://o.example/cb"],
      source: "registered",
      createdAt: new Date(),
      expiresAt: null,
      authorizationDetailsTypes: ["refund"],
    });
    const id = await listIdOf("refund");
    expect(
      (await admin(DELETE, { tenantId: tenantA, id })).data?.[
        "deleteDetailType"
      ],
    ).toBe(true);
  });

  test("deleteResource removes its types and takes them off the clients' lists", async () => {
    await created(
      admin,
      tenantA,
      payment({ type: "invoice", resourceId: resourceA2 }),
    );
    await created(
      admin,
      tenantA,
      payment({ type: "keep", resourceId: resourceA }),
    );
    await clientListing(tenantA, ["invoice", "keep"]);
    await mongo.db.adminEvents.raw.deleteMany({});
    expect(
      (await admin(DELETE_RESOURCE, { tenantId: tenantA, id: resourceA2 }))
        .data?.["deleteResource"],
    ).toBe(true);
    expect(await listed(tenantA)).toEqual(["keep"]);
    expect(
      await mongo.db.detailTypes.raw.countDocuments({ type: "invoice" }),
    ).toBe(0);
    expect(await servedTypes("dt-a", API)).toContain("keep");
    expect(await actions()).toEqual(["detailType.delete", "resource.delete"]);
    // A repeat is harmless.
    expect(
      (await admin(DELETE_RESOURCE, { tenantId: tenantA, id: resourceA2 }))
        .errors,
    ).toBeUndefined();
  });
});

async function servedFingerprint() {
  const tenant = await tenantResolver.resolveHost(`dt-a.${env.CLAVIX_DOMAIN}`);
  if (tenant === null) throw new Error("tenant not resolved");
  return fingerprintOf(await resourcesFor(tenant));
}

describe("permissions and isolation", () => {
  test("a viewer reads the types but changes none", async () => {
    const id = await listIdOf("keep");
    const read = one(
      await viewer(RESOURCE, { tenantId: tenantA, id: resourceA }),
      "resource",
    );
    expect(rowsOf(read["detailTypes"]).map((t) => t["type"])).toContain("keep");
    const refused = [
      await viewer(CREATE, {
        tenantId: tenantA,
        input: payment({ type: "nope" }),
      }),
      await viewer(UPDATE, { tenantId: tenantA, id, input: {} }),
      await viewer(DELETE, { tenantId: tenantA, id }),
    ];
    expect(refused.map(codeOf)).toEqual(Array(3).fill("FORBIDDEN"));
  });

  test("tenant A's admin cannot touch tenant B", async () => {
    const id = await listIdOf("keep");
    const refused = [
      await admin(CREATE, {
        tenantId: tenantB,
        input: payment({ type: "x", resourceId: resourceB }),
      }),
      await admin(UPDATE, { tenantId: tenantB, id, input: {} }),
      await admin(DELETE, { tenantId: tenantB, id }),
      await admin(LIST, { tenantId: tenantB }),
    ];
    expect(refused.map(codeOf)).toEqual(Array(4).fill("FORBIDDEN"));
  });

  test("A's types are unknown under B's id", async () => {
    const id = await listIdOf("keep");
    expect(
      codeOf(
        await adminB(UPDATE, {
          tenantId: tenantB,
          id,
          input: { name: { en: "Hijack" } },
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      (await adminB(DELETE, { tenantId: tenantB, id })).data?.[
        "deleteDetailType"
      ],
    ).toBe(false);
    const own = await adminB(LIST, { tenantId: tenantB });
    expect(JSON.stringify(own.data)).not.toContain("keep");
    expect(
      await mongo.db.detailTypes.raw.countDocuments({ type: "keep" }),
    ).toBe(1);
  });
});
