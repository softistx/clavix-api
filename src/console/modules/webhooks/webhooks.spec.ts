import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { webhookDeliveries } from "@/config/webhook-endpoints";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { codeOf, consoleAs } from "~/console";

const admin = consoleAs("wh-admin-a");
const viewer = consoleAs("wh-viewer-a");
const adminB = consoleAs("wh-admin-b");

let tenantA = "";
let tenantB = "";

// IP literals: the policy needs no DNS lookup, and 93.184.216.34 is public.
const URL_1 = "https://93.184.216.34/hook";
const FIELDS =
  "id url description types enabled disabledReason consecutiveGiveUps secrets { expiresAt }";
const CREATE = `mutation($tenantId: ID!, $input: CreateWebhookEndpointInput!) {
  createWebhookEndpoint(tenantId: $tenantId, input: $input) { secret endpoint { ${FIELDS} } }
}`;
const UPDATE = `mutation($tenantId: ID!, $id: ID!, $input: UpdateWebhookEndpointInput!) {
  updateWebhookEndpoint(tenantId: $tenantId, id: $id, input: $input) { ${FIELDS} }
}`;
const DELETE = `mutation($tenantId: ID!, $id: ID!) { deleteWebhookEndpoint(tenantId: $tenantId, id: $id) }`;
const ROLL = `mutation($tenantId: ID!, $id: ID!, $keepPrevious: Boolean!) {
  rollWebhookSecret(tenantId: $tenantId, id: $id, keepPrevious: $keepPrevious) { secret endpoint { ${FIELDS} } }
}`;
const TEST = `mutation($tenantId: ID!, $id: ID!) { sendTestWebhook(tenantId: $tenantId, id: $id) }`;
const LIST = `query($tenantId: ID!) { webhookEndpoints(tenantId: $tenantId) { ${FIELDS} } }`;
const ONE = `query($tenantId: ID!, $id: ID!) { webhookEndpoint(tenantId: $tenantId, id: $id) { ${FIELDS} } }`;
const TYPES = `query($tenantId: ID!) { webhookEventTypes(tenantId: $tenantId) }`;

type Created = {
  secret: string;
  endpoint: { id: string; secrets: unknown[]; enabled: boolean };
};
const createdOf = (result: Awaited<ReturnType<typeof admin>>) =>
  result.data?.["createWebhookEndpoint"] as Created;

beforeAll(async () => {
  tenantA = (await tenantsService.create({ slug: "wh-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "wh-b", name: "B" })).id;
  await access.grantTenant(tenantA, "wh-admin-a", "admin");
  await access.grantTenant(tenantA, "wh-viewer-a", "viewer");
  await access.grantTenant(tenantB, "wh-admin-b", "admin");
}, 30_000);

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.webhookEndpoints.raw.deleteMany({});
  await mongo.db.webhookDeliveries.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

describe("createWebhookEndpoint", () => {
  test("returns the secret once; the list never shows it", async () => {
    const result = await admin(CREATE, {
      tenantId: tenantA,
      input: { url: URL_1, description: "prod" },
    });
    expect(result.errors).toBeUndefined();
    const created = createdOf(result);
    expect(created.secret).toStartWith("whsec_");
    expect(created.endpoint.enabled).toBe(true);
    const list = await admin(LIST, { tenantId: tenantA });
    expect(JSON.stringify(list.data)).not.toContain(created.secret);
    expect(
      ((list.data?.["webhookEndpoints"] ?? []) as unknown[]).length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("refuses http, credentials, private addresses and unknown types", async () => {
    for (const input of [
      { url: "http://93.184.216.34/h" },
      { url: "https://user:pw@93.184.216.34/h" },
      { url: "https://127.0.0.1/h" },
      { url: "https://10.1.2.3/h" },
      { url: URL_1, types: ["nope.nope"] },
    ]) {
      const result = await admin(CREATE, { tenantId: tenantA, input });
      expect(codeOf(result)).toBe("BAD_USER_INPUT");
    }
  });

  test("a viewer and another tenant's admin are refused", async () => {
    const input = { url: URL_1 };
    expect(codeOf(await viewer(CREATE, { tenantId: tenantA, input }))).toBe(
      "FORBIDDEN",
    );
    expect(codeOf(await adminB(CREATE, { tenantId: tenantA, input }))).toBe(
      "FORBIDDEN",
    );
    expect(codeOf(await viewer(LIST, { tenantId: tenantB }))).toBe("FORBIDDEN");
  });

  test("the quota of the free plan is 2", async () => {
    await mongo.db.webhookEndpoints.raw.deleteMany({});
    for (const n of [1, 2]) {
      const ok = await admin(CREATE, {
        tenantId: tenantA,
        input: { url: `${URL_1}${n}` },
      });
      expect(ok.errors).toBeUndefined();
    }
    const over = await admin(CREATE, {
      tenantId: tenantA,
      input: { url: `${URL_1}3` },
    });
    expect(codeOf(over)).toBe("QUOTA_EXCEEDED");
    expect(await mongo.db.webhookEndpoints.raw.countDocuments({})).toBe(2);
  });
});

describe("webhookEndpoint", () => {
  test("reads one endpoint; unknown, malformed and other-tenant ids give null", async () => {
    await mongo.db.webhookEndpoints.raw.deleteMany({});
    const created = createdOf(
      await admin(CREATE, { tenantId: tenantA, input: { url: URL_1 } }),
    );
    const id = created.endpoint.id;
    const one = await viewer(ONE, { tenantId: tenantA, id });
    expect(one.errors).toBeUndefined();
    expect(
      (one.data?.["webhookEndpoint"] as { id: string } | undefined)?.id,
    ).toBe(id);
    expect(JSON.stringify(one.data)).not.toContain(created.secret);
    const missing = await admin(ONE, {
      tenantId: tenantA,
      id: "000000000000000000000000",
    });
    expect(missing.errors).toBeUndefined();
    expect(missing.data?.["webhookEndpoint"]).toBeNull();
    const malformed = await admin(ONE, { tenantId: tenantA, id: "nope" });
    expect(malformed.data?.["webhookEndpoint"]).toBeNull();
    // The endpoint of tenant A, asked through tenant B by B's own admin.
    const other = await adminB(ONE, { tenantId: tenantB, id });
    expect(other.errors).toBeUndefined();
    expect(other.data?.["webhookEndpoint"]).toBeNull();
  });
  test("needs view on the tenant", async () => {
    const id = "000000000000000000000000";
    expect(codeOf(await adminB(ONE, { tenantId: tenantA, id }))).toBe(
      "FORBIDDEN",
    );
  });
});

describe("update, roll, test and delete", () => {
  test("a full life", async () => {
    await mongo.db.webhookEndpoints.raw.deleteMany({});
    const made = createdOf(
      await admin(CREATE, { tenantId: tenantA, input: { url: URL_1 } }),
    );
    const id = made.endpoint.id;

    const updated = await admin(UPDATE, {
      tenantId: tenantA,
      id,
      input: { types: ["user.created"], description: "d", enabled: false },
    });
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.["updateWebhookEndpoint"]).toMatchObject({
      types: ["user.created"],
      description: "d",
      enabled: false,
      disabledReason: "MANUAL",
    });
    // A switched-off endpoint cannot be tested.
    expect(codeOf(await admin(TEST, { tenantId: tenantA, id }))).toBe(
      "BAD_USER_INPUT",
    );
    const on = await admin(UPDATE, {
      tenantId: tenantA,
      id,
      input: { enabled: true },
    });
    expect(on.data?.["updateWebhookEndpoint"]).toMatchObject({
      enabled: true,
      disabledReason: null,
    });

    const rolled = await admin(ROLL, {
      tenantId: tenantA,
      id,
      keepPrevious: true,
    });
    const next = rolled.data?.["rollWebhookSecret"] as Created;
    expect(next.secret).not.toBe(made.secret);
    expect(next.endpoint.secrets).toHaveLength(2);
    const expired = await admin(ROLL, {
      tenantId: tenantA,
      id,
      keepPrevious: false,
    });
    expect(
      (expired.data?.["rollWebhookSecret"] as Created | undefined)?.endpoint
        .secrets,
    ).toHaveLength(1);

    // Another tenant cannot reach it, even by id.
    expect(
      codeOf(await adminB(UPDATE, { tenantId: tenantB, id, input: {} })),
    ).toBe("NOT_FOUND");

    expect((await admin(DELETE, { tenantId: tenantA, id })).data).toEqual({
      deleteWebhookEndpoint: true,
    });
    expect(codeOf(await admin(TEST, { tenantId: tenantA, id }))).toBe(
      "NOT_FOUND",
    );
  });

  test("webhookEventTypes lists the catalogue", async () => {
    const result = await admin(TYPES, { tenantId: tenantA });
    const types = result.data?.["webhookEventTypes"] as string[];
    expect(types).toHaveLength(17);
    expect(types).toContain("session.signedIn");
  });
});

describe("deliveries", () => {
  const DELIVERIES = `query($tenantId: ID!) { webhookEndpoints(tenantId: $tenantId) { id deliveries(first: 2) { eventId type attempt status error durationMs delivered willRetry at } } }`;

  test("an admin reads the attempts of an endpoint, newest first, and a viewer too", async () => {
    await mongo.db.webhookEndpoints.raw.deleteMany({});
    const made = createdOf(
      await admin(CREATE, { tenantId: tenantA, input: { url: URL_1 } }),
    );
    const id = made.endpoint.id;
    for (let n = 1; n <= 3; n++) {
      await webhookDeliveries.record(tenantA, {
        endpointId: id,
        eventId: `evt-${n}`,
        type: "user.created",
        attempt: n,
        status: n === 3 ? null : 503,
        error: n === 3 ? "TimeoutError" : null,
        durationMs: 20 * n,
        delivered: false,
        willRetry: true,
      });
    }
    for (const who of [admin, viewer]) {
      const result = await who(DELIVERIES, { tenantId: tenantA });
      expect(result.errors).toBeUndefined();
      const [endpoint] = (result.data?.["webhookEndpoints"] ?? []) as {
        deliveries: { attempt: number; error: string | null }[];
      }[];
      expect(endpoint?.deliveries.map((row) => row.attempt)).toEqual([3, 2]);
      expect(endpoint?.deliveries[0]?.error).toBe("TimeoutError");
    }
    expect(codeOf(await adminB(DELIVERIES, { tenantId: tenantA }))).toBe(
      "FORBIDDEN",
    );
  });

  test("deleting the endpoint deletes its attempts", async () => {
    await mongo.db.webhookEndpoints.raw.deleteMany({});
    const made = createdOf(
      await admin(CREATE, { tenantId: tenantA, input: { url: URL_1 } }),
    );
    const id = made.endpoint.id;
    await webhookDeliveries.record(tenantA, {
      endpointId: id,
      eventId: "e",
      type: "user.created",
      attempt: 1,
      status: 200,
      error: null,
      durationMs: 1,
      delivered: true,
      willRetry: false,
    });
    await admin(DELETE, { tenantId: tenantA, id });
    expect(await webhookDeliveries.list(tenantA, id)).toEqual([]);
  });
});

describe("audit", () => {
  test("each write is recorded, with no secret in it", async () => {
    await mongo.db.adminEvents.raw.deleteMany({});
    await mongo.db.webhookEndpoints.raw.deleteMany({});
    const made = createdOf(
      await admin(CREATE, { tenantId: tenantA, input: { url: URL_1 } }),
    );
    const id = made.endpoint.id;
    await admin(UPDATE, { tenantId: tenantA, id, input: { description: "x" } });
    await admin(ROLL, { tenantId: tenantA, id, keepPrevious: true });
    await admin(DELETE, { tenantId: tenantA, id });
    const events = await mongo.db.adminEvents.raw
      .find({})
      .sort({ _id: 1 })
      .toArray();
    expect(events.map((event) => event.action)).toEqual([
      "webhook.create",
      "webhook.update",
      "webhook.rollSecret",
      "webhook.delete",
    ]);
    expect(JSON.stringify(events)).not.toContain(made.secret);
  });
});
