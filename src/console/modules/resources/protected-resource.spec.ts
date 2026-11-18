import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { protectedResource } from "@softistx/janus-oauth";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { consoleAs } from "~/console";

const admin = consoleAs("prm-admin");
const API = "https://api.prm.example/mcp";
const FIELDS = "id uri metadataUrl protectedResourceMetadata";
const CREATE = `mutation($t: ID!, $i: CreateResourceInput!) { createResource(tenantId: $t, input: $i) { ${FIELDS} } }`;
const GET = `query($t: ID!, $id: ID!) { resource(tenantId: $t, id: $id) { ${FIELDS} } }`;
const LIST = `query($t: ID!) { resources(tenantId: $t) { ${FIELDS} } }`;
const SCOPE = `mutation($t: ID!, $i: CreateScopeInput!) { createScope(tenantId: $t, input: $i) { id } }`;
const POLICY = `mutation($t: ID!, $i: OAuthPolicyInput!) { updateOAuthPolicy(tenantId: $t, input: $i) { version } }`;

let tenant = "";
let resourceId = "";
const issuer = issuerOf("prm", {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
});

// What janus's handler answers for the same inputs: the console shows this.
const served = async (options: { scopes?: string[]; dpop?: boolean }) => {
  const resource = protectedResource({
    resource: API,
    issuer,
    scopes: options.scopes ?? [],
    ...(options.dpop
      ? { dpop: { algorithms: ["ES256", "EdDSA"], required: true } }
      : {}),
  });
  return {
    url: resource.metadataUrl,
    body: await (
      await resource.metadata(new Request(resource.metadataUrl))
    ).text(),
  };
};

const read = async () => {
  const result = await admin(GET, { t: tenant, id: resourceId });
  expect(result.errors).toBeUndefined();
  return result.data?.["resource"] as {
    metadataUrl: string;
    protectedResourceMetadata: string;
  };
};

beforeAll(async () => {
  tenant = (await tenantsService.create({ slug: "prm", name: "PRM" })).id;
  await access.grantTenant(tenant, "prm-admin", "admin");
});

afterAll(async () => {
  await mongo.db.resources.raw.deleteMany({ tenantId: tenant as never });
  await mongo.db.scopes.raw.deleteMany({ tenantId: tenant as never });
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await oauthDb.collection("relations").deleteMany({});
});

describe("Resource.protectedResourceMetadata", () => {
  test("a new resource's document is janus's, at the RFC 9728 well-known path of its URI", async () => {
    const result = await admin(CREATE, { t: tenant, i: { uri: API } });
    expect(result.errors).toBeUndefined();
    const created = result.data?.["createResource"] as {
      id: string;
      metadataUrl: string;
      protectedResourceMetadata: string;
    };
    resourceId = created.id;
    const expected = await served({});
    expect(created.metadataUrl).toBe(
      "https://api.prm.example/.well-known/oauth-protected-resource/mcp",
    );
    expect(created.metadataUrl).toBe(expected.url);
    expect(created.protectedResourceMetadata).toBe(expected.body);
    expect(JSON.parse(created.protectedResourceMetadata)).toMatchObject({
      resource: API,
      authorization_servers: [issuer],
    });
  });

  test("the resource's scopes are in scopes_supported, and only its own", async () => {
    for (const name of ["read", "write"]) {
      const made = await admin(SCOPE, {
        t: tenant,
        i: { name, resourceId },
      });
      expect(made.errors).toBeUndefined();
    }
    await admin(SCOPE, { t: tenant, i: { name: "openid" } });
    const found = await read();
    const expected = await served({ scopes: ["read", "write"] });
    expect(found.protectedResourceMetadata).toBe(expected.body);
    expect(
      JSON.parse(found.protectedResourceMetadata).scopes_supported.sort(),
    ).toEqual(["read", "write"]);
    const listed = await admin(LIST, { t: tenant });
    const rows = (listed.data?.["resources"] ?? []) as {
      protectedResourceMetadata: string;
    }[];
    expect(rows[0]?.protectedResourceMetadata).toBe(expected.body);
  });

  test("DPoP on: the tenant requires proofs and the document says so; off: it does not", async () => {
    const on = await admin(POLICY, {
      t: tenant,
      i: { dpop: { required: true } },
    });
    expect(on.errors).toBeUndefined();
    const required = await read();
    expect(required.protectedResourceMetadata).toBe(
      (await served({ scopes: ["read", "write"], dpop: true })).body,
    );
    expect(JSON.parse(required.protectedResourceMetadata)).toMatchObject({
      dpop_signing_alg_values_supported: ["ES256", "EdDSA"],
      dpop_bound_access_tokens_required: true,
    });
    await admin(POLICY, { t: tenant, i: { dpop: { required: false } } });
    const off = JSON.parse((await read()).protectedResourceMetadata);
    expect(off.dpop_signing_alg_values_supported).toBeUndefined();
    expect(off.dpop_bound_access_tokens_required).toBeUndefined();
  });
});
