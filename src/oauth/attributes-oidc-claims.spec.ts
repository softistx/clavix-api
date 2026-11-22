import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeJwt } from "jose";
import { ObjectId } from "mongodb";
import { z } from "zod";
import {
  attributeScopesFor,
  attributesFor,
  attributesService,
  roleAttributesService,
  attributeValuesService as values,
} from "@/config/attributes";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { resourcesService } from "@/config/resources";
import { rolesFor, rolesService } from "@/config/roles";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { jsonOf } from "~/json";
import { defined, parsed } from "~/narrow";
import { recordBody } from "~/oauth-bodies";
import { createFlow } from "~/oauth-flow";

const SLUG = "attrs-oidc";
const USER = "user-attrs-oidc";
const API = "https://api.attrs-oidc.test/api";
const RESOURCE_USER = "user-attrs-resource";
const SCOPE = "profile";
const admin = { kind: "admin", id: "admin-1" } as const;
const label = [{ locale: "en", text: "Label" }];
const flow = createFlow({ rolesFor, attributesFor, attributeScopesFor });

// A catalogue that drifted: it hands over names the server owns.
const drifted = createFlow({
  rolesFor,
  attributesFor: () => async () => ({
    roles: ["evil"],
    email: "evil@attrs.test",
    nonce: "evil",
    picture: "https://evil.test/p.png",
  }),
  attributeScopesFor,
});

let tenant = new ObjectId();

const create = (
  key: string,
  family: "USER" | "ROLE" = "USER",
  emissionScope: string | null = SCOPE,
) =>
  attributesService.create(tenant, {
    key,
    family,
    type: "STRING",
    label,
    emissionScope,
  });

const save = (
  attributeId: ObjectId,
  text: string,
  userId: string,
  section?: Parameters<typeof values.save>[5],
) =>
  values.save(
    tenant,
    userId,
    [{ attributeId: attributeId.toHexString(), value: { text } }],
    admin,
    false,
    section,
  );

const stringsOf = (document: Record<string, unknown>, key: string) =>
  parsed(z.array(z.string()), document[key]);

beforeAll(async () => {
  await drifted.setUp("attrs-drift", []);
  tenant = new ObjectId((await flow.setUp(SLUG, [API])).tenantId);
  await save((await create("nick"))._id, "bob", USER);
  await save((await create("quiet", "USER", null))._id, "hidden", USER);
  const old = await create("old");
  await save(old._id, "gone", USER);
  await attributesService.archive(tenant, old.id);
  const wide = await rolesService.create(tenant, { name: "member" });
  const licence = await create("licence", "ROLE");
  await roleAttributesService.assign(
    tenant,
    wide._id.toHexString(),
    licence.id,
    false,
  );
  await rolesService.assign(tenant, wide._id.toHexString(), USER);
  await save(licence._id, "L-42", USER, {
    family: "ROLE",
    links: await roleAttributesService.linksHeld(
      tenant,
      USER,
      wide._id.toHexString(),
    ),
  });
  // A role of the resource only: its attribute never reaches the id_token.
  const resource = defined(
    (await resourcesService.listResources(tenant)).find((r) => r.uri === API),
    "the resource",
  );
  const narrow = await rolesService.create(tenant, {
    name: "scoped",
    resourceId: resource._id.toHexString(),
  });
  const badge = await create("badge", "ROLE");
  await roleAttributesService.assign(
    tenant,
    narrow._id.toHexString(),
    badge.id,
    false,
  );
  await rolesService.assign(tenant, narrow._id.toHexString(), RESOURCE_USER);
  await save(badge._id, "B-7", RESOURCE_USER, {
    family: "ROLE",
    links: await roleAttributesService.linksHeld(
      tenant,
      RESOURCE_USER,
      narrow._id.toHexString(),
    ),
  });
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

describe("the attribute claims of the id_token and userinfo", () => {
  test("the id_token carries them when the emission scope is granted", async () => {
    const tokens = await flow.tokensOf(SLUG, `openid ${SCOPE}`, {
      userId: USER,
    });
    const claims = decodeJwt(tokens.id_token ?? "");
    expect(claims["nick"]).toBe("bob");
    expect(claims["licence"]).toBe("L-42");
    expect(claims["roles"]).toEqual(["member"]);
  });

  test("userinfo carries the same claims", async () => {
    const tokens = await flow.tokensOf(SLUG, `openid ${SCOPE}`, {
      userId: USER,
    });
    const response = await flow.get(
      SLUG,
      "/userinfo",
      `Bearer ${tokens.access_token}`,
    );
    expect(response.status).toBe(200);
    const body = await jsonOf(response, recordBody);
    expect(body["nick"]).toBe("bob");
    expect(body["licence"]).toBe("L-42");
  });

  test("without the scope neither carries them", async () => {
    const tokens = await flow.tokensOf(SLUG, "openid", { userId: USER });
    expect(decodeJwt(tokens.id_token ?? "")["nick"]).toBeUndefined();
    const response = await flow.get(
      SLUG,
      "/userinfo",
      `Bearer ${tokens.access_token}`,
    );
    expect((await jsonOf(response, recordBody))["nick"]).toBeUndefined();
  });

  test("an archived attribute and one with no scope are never emitted", async () => {
    const tokens = await flow.tokensOf(SLUG, `openid ${SCOPE}`, {
      userId: USER,
    });
    const claims = decodeJwt(tokens.id_token ?? "");
    expect([claims["old"], claims["quiet"]]).toEqual([undefined, undefined]);
  });

  test("a role attribute needs a tenant-wide role: a resource role does not count", async () => {
    const tokens = await flow.tokensOf(SLUG, `openid ${SCOPE}`, {
      userId: RESOURCE_USER,
    });
    expect(decodeJwt(tokens.id_token ?? "")["badge"]).toBeUndefined();
  });
});

describe("a claim the server owns", () => {
  test("is never overridden by an attribute in the id_token or userinfo", async () => {
    const tokens = await drifted.tokensOf("attrs-drift", `openid ${SCOPE}`, {
      userId: USER,
    });
    const claims = decodeJwt(tokens.id_token ?? "");
    expect(claims["roles"]).toEqual([]);
    expect(claims["nonce"]).not.toBe("evil");
    expect(claims["email"]).not.toBe("evil@attrs.test");
    expect(claims["picture"]).not.toBe("https://evil.test/p.png");
    const response = await drifted.get(
      "attrs-drift",
      "/userinfo",
      `Bearer ${tokens.access_token}`,
    );
    const body = await jsonOf(response, recordBody);
    expect(body["roles"]).toEqual([]);
    expect(body["email"]).not.toBe("evil@attrs.test");
    expect(body["picture"]).not.toBe("https://evil.test/p.png");
  });
});

describe("the discovery document", () => {
  test("lists the emitted claims, not the archived or unscoped ones", async () => {
    const response = await flow.get(SLUG, "/.well-known/openid-configuration");
    expect(response.status).toBe(200);
    const supported = stringsOf(
      await jsonOf(response, recordBody),
      "claims_supported",
    );
    expect(supported).toEqual(
      expect.arrayContaining(["nick", "licence", "roles", "sub"]),
    );
    expect(supported).not.toContain("old");
    expect(supported).not.toContain("quiet");
  });

  test("follows the catalogue: a new attribute is listed, an archived one is not", async () => {
    const added = await create("fresh");
    const listed = async () =>
      stringsOf(
        await jsonOf(
          await flow.get(SLUG, "/.well-known/openid-configuration"),
          recordBody,
        ),
        "claims_supported",
      );
    expect(await listed()).toContain("fresh");
    await attributesService.archive(tenant, added.id);
    expect(await listed()).not.toContain("fresh");
  });
});
