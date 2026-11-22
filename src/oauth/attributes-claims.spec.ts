import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLIENT_CREDENTIALS_GRANT } from "@softistx/janus-oauth";
import { decodeJwt } from "jose";
import { ObjectId } from "mongodb";
import {
  attributesFor,
  attributesService,
  roleAttributesService,
  attributeValuesService as values,
} from "@/config/attributes";
import { mongo } from "@/config/db";
import { noDetailTypes } from "@/config/no-ops";
import { oauthDb } from "@/config/oauth-db";
import { registerStoredResource, resourcesService } from "@/config/resources";
import { rolesFor, rolesService } from "@/config/roles";
import { registerClient } from "@/modules/clients";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { jsonOf, tokenBody } from "~/json";
import { defined } from "~/narrow";
import { answerBody } from "~/oauth-bodies";
import { createFlow } from "~/oauth-flow";

const X = "https://x.attributes.test/api";
const Y = "https://y.attributes.test/api";
const SLUG = "attrs-a";
const USER = "user-attrs";
const admin = { kind: "admin", id: "admin-1" } as const;
const label = [{ locale: "en", text: "Label" }];
const flow = createFlow({ rolesFor, attributesFor });

let tenant = new ObjectId();
let doctor = new ObjectId();
let badge = new ObjectId();

const tokenOf = async (resource: string | undefined, scope = "read") =>
  decodeJwt(
    (
      await flow.tokensOf(SLUG, scope, {
        userId: USER,
        ...(resource === undefined ? {} : { resource }),
      })
    ).access_token ?? "",
  );

const create = (
  key: string,
  type: "STRING" | "NUMBER" | "DATE" | "BOOLEAN" | "MULTI_SELECT",
  family: "USER" | "ROLE" = "USER",
  emissionScope: string | null = "read",
) =>
  attributesService.create(tenant, {
    key,
    family,
    type,
    label,
    emissionScope,
    ...(type === "MULTI_SELECT"
      ? {
          options: [
            { key: "a", label },
            { key: "b", label },
          ],
        }
      : {}),
  });

const save = (
  attributeId: ObjectId,
  value: Record<string, unknown>,
  section?: Parameters<typeof values.save>[5],
) =>
  values.save(
    tenant,
    USER,
    [{ attributeId: attributeId.toHexString(), value }],
    admin,
    false,
    section,
  );

beforeAll(async () => {
  tenant = new ObjectId((await flow.setUp(SLUG, [X, Y])).tenantId);
  const resourceX = defined(
    (await resourcesService.listResources(tenant)).find((r) => r.uri === X),
    "resource X",
  );
  const encoded = [
    ["nick", "STRING", { text: "bob" }],
    ["age", "NUMBER", { number: 31 }],
    ["born", "DATE", { date: "1994-05-06" }],
    ["vip", "BOOLEAN", { boolean: false }],
    ["tags", "MULTI_SELECT", { options: ["b", "a"] }],
  ] as const;
  for (const [key, type, value] of encoded)
    await save((await create(key, type))._id, value);
  await save((await create("quiet", "STRING", "USER", null))._id, {
    text: "hidden",
  });
  const old = await create("old", "STRING");
  await save(old._id, { text: "gone" });
  await attributesService.archive(tenant, old.id);
  doctor = (
    await rolesService.create(tenant, {
      name: "doctor",
      resourceId: resourceX._id.toHexString(),
    })
  )._id;
  const attribute = await create("licence", "STRING", "ROLE");
  badge = attribute._id;
  await roleAttributesService.assign(
    tenant,
    doctor.toHexString(),
    attribute.id,
    false,
  );
  await rolesService.assign(tenant, doctor.toHexString(), USER);
  await save(
    badge,
    { text: "L-42" },
    {
      family: "ROLE",
      links: await roleAttributesService.linksHeld(
        tenant,
        USER,
        doctor.toHexString(),
      ),
    },
  );
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  for (const name of [
    "roleAttributes",
    "attributeValues",
    "userAttributes",
    "roleAssignments",
    "roles",
    "resources",
    "scopes",
  ] as const)
    await mongo.db[name].raw.deleteMany({});
  for (const name of ["oauthPartitionedClients", "oauthPartitionedGrants"]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

describe("the attribute claims of an access token", () => {
  test("a token with the emission scope carries the values, encoded", async () => {
    const claims = await tokenOf(X);
    expect(claims["nick"]).toBe("bob");
    expect(claims["age"]).toBe(31);
    expect(claims["born"]).toBe("1994-05-06");
    expect(claims["vip"]).toBe(false);
    expect(claims["tags"]).toEqual(["b", "a"]);
  });

  test("a token without the scope carries none", async () => {
    const claims = await tokenOf(undefined, "openid");
    for (const key of ["nick", "age", "born", "vip", "tags", "licence"])
      expect(claims[key]).toBeUndefined();
  });

  test("an attribute with no emission scope, or archived, is never emitted", async () => {
    const claims = await tokenOf(X);
    expect(claims["quiet"]).toBeUndefined();
    expect(claims["old"]).toBeUndefined();
  });

  test("a role attribute is emitted for its resource only", async () => {
    expect((await tokenOf(X))["licence"]).toBe("L-42");
    expect((await tokenOf(Y))["licence"]).toBeUndefined();
    // Another resource still gets the user attributes.
    expect((await tokenOf(Y))["nick"]).toBe("bob");
  });

  test("a refreshed token omits the role attribute once the role is removed", async () => {
    const tokens = await flow.tokensOf(SLUG, "read", {
      resource: X,
      userId: USER,
    });
    expect(decodeJwt(tokens.access_token ?? "")["licence"]).toBe("L-42");
    await rolesService.unassign(tenant, doctor.toHexString(), USER);
    const client = defined(flow.clients[SLUG], "the client");
    const refreshed = await flow.post(
      SLUG,
      "/token",
      {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token ?? "",
        resource: X,
      },
      flow.basic(client.id, client.secret),
    );
    expect(refreshed.status).toBe(200);
    const body = await jsonOf(refreshed, tokenBody);
    const claims = decodeJwt(body.access_token ?? "");
    expect(claims["licence"]).toBeUndefined();
    expect(claims["nick"]).toBe("bob");
    // The role comes back: so does the claim, with its stored value.
    await rolesService.assign(tenant, doctor.toHexString(), USER);
    expect((await tokenOf(X))["licence"]).toBe("L-42");
  });

  test("a client credentials token carries no attribute", async () => {
    const operator = await registerClient(
      {
        detailTypes: noDetailTypes,
        now: () => new Date(),
        db: oauthDb,
        findTenant: (slug) => mongo.db.tenants.findFirst({ slug }),
      },
      {
        tenant: SLUG,
        name: "machine",
        clientId: USER,
        redirectUris: [],
        type: "confidential",
        grants: [CLIENT_CREDENTIALS_GRANT],
        allowedScopes: ["read"],
        defaultScopes: ["read"],
      },
    );
    await registerStoredResource({ tenant: SLUG, uri: X, scopes: ["read"] });
    await resourcesService.updateResource(
      tenant,
      defined(
        (await resourcesService.listResources(tenant)).find(
          (resource) => resource.uri === X,
        ),
        "resource X",
      )._id.toHexString(),
      { allowClientCredentials: true },
    );
    // The machine's client id is the very user id that holds the values.
    const response = await flow.post(
      SLUG,
      "/token",
      { grant_type: CLIENT_CREDENTIALS_GRANT, resource: X, scope: "read" },
      flow.basic(USER, operator.clientSecret ?? ""),
    );
    expect(response.status).toBe(200);
    const claims = decodeJwt(
      (await jsonOf(response, answerBody)).access_token ?? "",
    );
    expect(claims["sub"]).toBe(USER);
    for (const key of ["nick", "age", "licence", "roles"])
      expect(claims[key]).toBeUndefined();
  });
});
