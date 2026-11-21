import { beforeAll, describe, expect, test } from "bun:test";
import { access, linkTenantToPlatform } from "@/config/access";
import { mongo } from "@/config/db";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { consoleRequestAs } from "~/console";

// The console UI's Applications read (clavix-ui `app/api/resources.server.ts`): every resource with
// its scopes and detail types, nested four lists deep. With graxia's default cost limit (5 000, ten
// items assumed per list) it costs 24 530 and was refused before any resolver ran.
const TEXT = "{ fr en }";
const VALUE = `{ value label ${TEXT} }`;
const DETAIL_TYPE = `id resourceId type name ${TEXT} description ${TEXT} createdAt updatedAt
  fields { key kind label ${TEXT} required min max maxLength values ${VALUE} }
  actions ${VALUE}`;
const SCOPE = "id name description { fr en } resourceId claims";
const RESOURCE = `id uri name allowClientCredentials metadataUrl protectedResourceMetadata createdAt
  scopes { ${SCOPE} } detailTypes { ${DETAIL_TYPE} }`;
const APPLICATIONS = `query Resources($tenantId: ID!) {
  resources(tenantId: $tenantId) { ${RESOURCE} }
  scopes(tenantId: $tenantId) { ${SCOPE} }
}`;

const OWNER = "cost-platform-owner";
let clavix = "";

beforeAll(async () => {
  const found = await mongo.db.tenants.findFirst({
    slug: PLATFORM_TENANT_SLUG,
  });
  clavix = found?._id.toHexString() ?? "";
  await linkTenantToPlatform(clavix);
  // A platform owner with no role of its own on any tenant (the staging report).
  await access.grantPlatform(OWNER, "owner");
});

describe("console operation cost", () => {
  test("the console UI's Applications read is answered, not refused for its cost", async () => {
    const response = await consoleRequestAs(OWNER)(APPLICATIONS, {
      tenantId: clavix,
    });
    const body = (await response.json()) as {
      data?: { resources: unknown[]; scopes: unknown[] } | null;
      errors?: { extensions?: { code?: string } }[];
    };
    expect(body.errors).toBeUndefined();
    expect(Array.isArray(body.data?.resources)).toBe(true);
  });

  test("the cost limit is still on: a read that multiplies the lists is refused", async () => {
    const aliased = Array.from(
      { length: 20 },
      (_, i) => `r${i}: resources(tenantId: $tenantId) { ${RESOURCE} }`,
    ).join("\n");
    const response = await consoleRequestAs(OWNER)(
      `query($tenantId: ID!) { ${aliased} }`,
      { tenantId: clavix },
    );
    const body = (await response.json()) as {
      data?: unknown;
      errors?: { extensions?: { code?: string; limit?: { name?: string } } }[];
    };
    expect(body.data).toBeUndefined();
    expect(body.errors?.[0]?.extensions?.limit?.name).toBe("cost");
  });
});
