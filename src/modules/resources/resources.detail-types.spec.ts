import { beforeAll, describe, expect, test } from "bun:test";
import { s256Challenge } from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { scopeToTenant } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { resourcesFor } from "@/config/resources";
import { tenantResolver } from "@/config/tenancy";
import { fingerprintOf } from "@/oauth/resolution";
import { errorBody, jsonOf } from "~/json";
import { defined, recordOf } from "~/narrow";
import { createFlow, DOMAIN, REDIRECT } from "~/oauth-flow";
import { mongoDetailTypeClients } from "./resources.client-lists";
import { CatalogError } from "./resources.errors";
import { ResourcesService } from "./resources.service";
import type { DetailTypeInput } from "./resources.types";

const PAY = "https://pay.example/api";
const OTHER = "https://other.example/api";
const VERIFIER = "d".repeat(64);
const flow = createFlow();
const service = new ResourcesService({
  resources: mongo.db.resources,
  scopes: mongo.db.scopes,
  detailTypes: mongo.db.detailTypes,
  clients: mongoDetailTypeClients(oauthDb),
  userinfoOf: (slug) => `https://${slug}.${DOMAIN}/userinfo`,
  findTenant: (slug) => mongo.db.tenants.findFirst({ slug }),
  scopesDropped: async () => {},
});
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });
const text = (en: string) => [
  { locale: "fr", text: en },
  { locale: "en", text: en },
];

const payment = (extra: Partial<DetailTypeInput> = {}): DetailTypeInput => ({
  type: "payment",
  name: text("Payment"),
  description: text("Pay someone"),
  fields: [
    {
      key: "amount",
      kind: "number",
      label: text("Amount"),
      required: true,
      min: 0.01,
      max: 1000,
    },
    {
      key: "currency",
      kind: "enum",
      label: text("Currency"),
      required: true,
      values: [{ value: "EUR", label: text("Euro") }],
    },
  ],
  actions: [{ value: "initiate", label: text("Start") }],
  ...extra,
});

async function tenantIdOf(slug: string): Promise<ObjectId> {
  const tenant = await findTenant(slug);
  if (tenant === undefined) throw new Error(`no tenant ${slug}`);
  return tenant._id;
}

/** A resource with no scope at all, only detail types (R1: it still builds). */
async function typesOnlyResource(slug: string, uri: string) {
  const tenantId = await tenantIdOf(slug);
  const resource = await scopeToTenant(mongo.db.resources, tenantId).create({
    uri,
    name: uri,
  });
  return { tenantId, resourceId: resource._id };
}

async function addType(slug: string, uri: string, input: DetailTypeInput) {
  const tenantId = await tenantIdOf(slug);
  const resource = await scopeToTenant(mongo.db.resources, tenantId).findFirst({
    uri,
  });
  if (resource === undefined) throw new Error("no resource");
  return service.saveDetailType(tenantId, resource._id, input, {
    replace: true,
  });
}

/** The client lists these types (R3 will do it through the console and the CLI). */
async function listTypes(slug: string, types: string[]) {
  const store = createMongoOAuth(oauthDb, {
    partition: (await tenantIdOf(slug)).toHexString(),
  });
  const client = await store.findClient("backend");
  if (client === null) throw new Error("no client");
  await store.upsertClient({ ...client, authorizationDetailsTypes: types });
}

const discovery = async (
  slug: string,
  path = "/.well-known/openid-configuration",
) => recordOf(await (await flow.get(slug, path)).json());

async function par(slug: string, details: unknown, resource = PAY) {
  const client = defined(flow.clients[slug], "the flow client");
  return flow.post(
    slug,
    "/par",
    {
      response_type: "code",
      client_id: client.id,
      redirect_uri: REDIRECT,
      code_challenge: await s256Challenge(VERIFIER),
      code_challenge_method: "S256",
      resource,
      state: "s",
      authorization_details: JSON.stringify(details),
    },
    flow.basic(client.id, client.secret),
  );
}

const good = [
  { type: "payment", amount: 12.5, currency: "EUR", actions: ["initiate"] },
];
const errorOf = async (response: Response) =>
  (await jsonOf(response, errorBody)).error;

beforeAll(async () => {
  await flow.setUp("rar-a", [], { par: true });
  await flow.setUp("rar-b", [], { par: true });
  await flow.setUp("rar-none", [PAY], { par: true });
  await typesOnlyResource("rar-a", PAY);
  await typesOnlyResource("rar-b", OTHER);
});

describe("detail types served to janus", () => {
  test("a resource with only types builds, and discovery lists them", async () => {
    // Nothing declared yet: the resource has no scope and no type, so it is left out.
    expect(
      (await discovery("rar-a"))["authorization_details_types_supported"],
    ).toBeUndefined();
    await addType("rar-a", PAY, payment());
    for (const path of [
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server",
    ]) {
      expect(
        (await discovery("rar-a", path))[
          "authorization_details_types_supported"
        ],
      ).toEqual(["payment"]);
    }
  });

  test("a tenant without types lists none and still refuses the parameter", async () => {
    expect(
      (await discovery("rar-none"))["authorization_details_types_supported"],
    ).toBeUndefined();
    const response = await par("rar-none", good);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_request");
  });

  test("/par accepts a detail of a type the client lists", async () => {
    await listTypes("rar-a", ["payment"]);
    const response = await par("rar-a", good);
    expect(response.status).toBe(201);
  });

  test("/par refuses what the compiled schema refuses, as invalid_authorization_details", async () => {
    for (const detail of [
      { type: "payment", amount: -1, currency: "EUR" },
      { type: "payment", amount: 1, currency: "GBP" },
      { type: "payment", amount: 1 },
      { type: "payment", amount: 1, currency: "EUR", extra: true },
      { type: "payment", amount: 1, currency: "EUR", actions: ["delete"] },
    ]) {
      const response = await par("rar-a", [detail]);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe("invalid_authorization_details");
    }
  });

  test("a type the client does not list is refused", async () => {
    await addType("rar-a", PAY, payment({ type: "refund" }));
    const response = await par("rar-a", [{ type: "refund" }]);
    expect(await errorOf(response)).toBe("invalid_authorization_details");
  });

  test("an edited type rebuilds the issuer on the next request, with no restart", async () => {
    const tenant = defined(
      await tenantResolver.resolveHost(`rar-a.${DOMAIN}`),
      "the tenant",
    );
    const before = fingerprintOf(await resourcesFor(tenant));
    // The cap is tightened: 12.5 was accepted a moment ago, it is not now.
    await addType(
      "rar-a",
      PAY,
      payment({
        fields: [
          {
            key: "amount",
            kind: "number",
            label: text("Amount"),
            required: true,
            max: 10,
          },
          {
            key: "currency",
            kind: "enum",
            label: text("Currency"),
            required: true,
            values: [{ value: "EUR", label: text("Euro") }],
          },
        ],
      }),
    );
    expect(fingerprintOf(await resourcesFor(tenant))).not.toBe(before);
    expect(await errorOf(await par("rar-a", good))).toBe(
      "invalid_authorization_details",
    );
    expect((await par("rar-a", [{ ...good[0], amount: 5 }])).status).toBe(201);
  });

  test("another tenant's type is unknown", async () => {
    // rar-b has its own type; it neither lists nor accepts rar-a's "payment".
    await addType("rar-b", OTHER, payment({ type: "transfer" }));
    expect(
      (await discovery("rar-b"))["authorization_details_types_supported"],
    ).toEqual(["transfer"]);
    await listTypes("rar-b", ["transfer", "payment"]);
    const response = await par("rar-b", good, OTHER);
    expect(await errorOf(response)).toBe("invalid_authorization_details");
    const served = await resourcesFor(
      defined(
        await tenantResolver.resolveHost(`rar-b.${DOMAIN}`),
        "the tenant",
      ),
    );
    expect(Object.keys(served[PAY] ?? {})).toEqual([]);
    expect(Object.keys(served[OTHER]?.authorizationDetails ?? {})).toEqual([
      "transfer",
    ]);
  });
});

describe("saveDetailType", () => {
  test("replacing a type with a smaller definition clears what it dropped", async () => {
    await addType("rar-none", PAY, payment({ type: "clearing" }));
    const replaced = await addType(
      "rar-none",
      PAY,
      payment({ type: "clearing", actions: undefined }),
    );
    expect(replaced.actions ?? []).toEqual([]);
    const tenantId = await tenantIdOf("rar-none");
    const stored = await scopeToTenant(
      mongo.db.detailTypes,
      tenantId,
    ).findFirst({
      type: "clearing",
    });
    expect(stored?.actions ?? []).toEqual([]);
  });

  test("a type name is unique in the tenant, across resources (D2), not across tenants", async () => {
    const { tenantId, resourceId } = await typesOnlyResource(
      "rar-a",
      "https://second.example/api",
    );
    const clash = service.saveDetailType(tenantId, resourceId, payment());
    expect(clash).rejects.toMatchObject({ code: "CONFLICT" });
    // Another tenant may use the same name.
    expect(await addType("rar-b", OTHER, payment())).toMatchObject({
      type: "payment",
    });
  });

  test("an invalid definition is BAD_USER_INPUT", async () => {
    const { tenantId, resourceId } = await typesOnlyResource(
      "rar-none",
      "https://third.example/api",
    );
    const attempt = service.saveDetailType(
      tenantId,
      resourceId,
      payment({ type: "" }),
    );
    expect(attempt).rejects.toBeInstanceOf(CatalogError);
    expect(attempt).rejects.toMatchObject({ code: "BAD_USER_INPUT" });
  });
});
