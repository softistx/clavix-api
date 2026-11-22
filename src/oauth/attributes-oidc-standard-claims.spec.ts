import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeJwt } from "jose";
import { ObjectId } from "mongodb";
import {
  attributeScopesFor,
  attributesFor,
  attributesService,
  attributeValuesService as values,
} from "@/config/attributes";
import { mongo } from "@/config/db";
import { rolesFor } from "@/config/roles";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { jsonOf } from "~/json";
import { recordBody } from "~/oauth-bodies";
import { createFlow } from "~/oauth-flow";

const SLUG = "attrs-standard";
const USER = "user-attrs-standard";
const PICTURE = "https://attrs-standard.test/media/avatar/key";
const flow = createFlow({
  claimsFor: () => async () => ({ name: "Ada", picture: PICTURE }),
  rolesFor,
  attributesFor,
  attributeScopesFor,
});

beforeAll(async () => {
  const { tenantId } = await flow.setUp(SLUG, []);
  const tenant = new ObjectId(tenantId);
  const nick = await attributesService.create(tenant, {
    key: "nick",
    family: "USER",
    type: "STRING",
    label: [{ locale: "en", text: "Nick" }],
    emissionScope: "profile",
  });
  await values.save(
    tenant,
    USER,
    [{ attributeId: nick.id, value: { text: "ada" } }],
    { kind: "admin", id: "admin-1" },
    false,
  );
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  for (const name of ["attributeValues", "userAttributes"] as const)
    await mongo.db[name].raw.deleteMany({});
});

describe("an attribute emitted under the standard `profile` scope", () => {
  test("leaves name and picture released in the id_token and userinfo", async () => {
    const tokens = await flow.tokensOf(SLUG, "openid profile", {
      userId: USER,
    });
    const claims = decodeJwt(tokens.id_token ?? "");
    expect(claims["nick"]).toBe("ada");
    expect(claims["name"]).toBe("Ada");
    expect(claims["picture"]).toBe(PICTURE);
    const body = await jsonOf(
      await flow.get(SLUG, "/userinfo", `Bearer ${tokens.access_token}`),
      recordBody,
    );
    expect(body["nick"]).toBe("ada");
    expect(body["name"]).toBe("Ada");
    expect(body["picture"]).toBe(PICTURE);
  });
});
