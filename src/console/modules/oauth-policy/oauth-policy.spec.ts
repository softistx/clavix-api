import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OptimisticLockError } from "@softistx/mongo";
import type { GraphQLError } from "graphql";
import { createApp } from "@/app";
import { access } from "@/config/access";
import { adminEventRecorder } from "@/config/admin-events";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import type { ConsoleAdmins, ConsoleUsers } from "@/console/context";
import { createExclusive } from "@/console/exclusive";
import { CONSOLE_CLIENT_ID } from "@/console/identity";
import { OAuthPolicyService } from "@/modules/oauth-policy/service";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { CONSOLE_PATH } from "../../identity";

interface Policy {
  tenantId: string;
  par: { required: boolean };
  dpop: { required: boolean };
  version: number;
}
interface Result {
  data?: Record<string, Policy> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
  text: string;
}

const as = async (
  userId: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Result> => {
  const response = await createApp({
    console: {
      authenticate: async () => ({
        userId,
        clientId: CONSOLE_CLIENT_ID,
        grantId: "g",
        scopes: ["console"],
        clientName: null,
        bound: null,
        jkt: null,
        authorizationDetails: [],
      }),
      access,
      adminEvents: adminEventRecorder,
      admins: {} as ConsoleAdmins,
      users: {} as ConsoleUsers,
      exclusive: createExclusive(),
      directory: {
        findUser: async () => null,
        emailVerified: async () => true,
        findUserByEmail: async () => null,
        tenantsByIds: async () => [],
      },
    },
  }).request(`http://localhost${CONSOLE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer x",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  return { ...(JSON.parse(text) as Omit<Result, "text">), text };
};
const codeOf = (result: Result) => result.errors?.[0]?.extensions?.code;

const FIELDS = "tenantId version par { required } dpop { required }";
const POLICY = `query ($t: ID!) { oauthPolicy(tenantId: $t) { ${FIELDS} } }`;
const UPDATE = `mutation ($t: ID!, $i: OAuthPolicyInput!) {
  updateOAuthPolicy(tenantId: $t, input: $i) { ${FIELDS} }
}`;

const OWNER = "oap-owner";
const VIEWER = "oap-viewer";
const OTHER = "oap-other";
const PLATFORM_ADMIN = "oap-platform-admin";
let a = "";
let b = "";

const stored = async (id: string) => {
  const [tenant] = await tenantsService.activeByIds([id]);
  if (tenant === undefined) throw new Error("no tenant");
  return tenant;
};
const eventsOf = async (tenantId: string) =>
  (
    await mongo.db.adminEvents.raw
      .find({ action: "oauthPolicy.update", "target.id": tenantId })
      .sort({ _id: 1 })
      .toArray()
  ).map((event) => event["target"]);

beforeAll(async () => {
  a = (await tenantsService.create({ slug: "oap-a", name: "A" })).id;
  b = (await tenantsService.create({ slug: "oap-b", name: "B" })).id;
  await access.grantTenant(a, OWNER, "owner");
  await access.grantTenant(a, VIEWER, "viewer");
  await access.grantTenant(b, OTHER, "admin");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $nin: [PLATFORM_TENANT_SLUG] },
  });
  await oauthDb.collection("relations").deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
});

describe("guards", () => {
  test("a viewer reads the policy and cannot change it", async () => {
    const read = await as(VIEWER, POLICY, { t: a });
    expect(read.data?.["oauthPolicy"]?.par.required).toBe(true);
    const before = (await stored(a)).version;
    const write = await as(VIEWER, UPDATE, {
      t: a,
      i: { par: { required: false } },
    });
    expect(codeOf(write)).toBe("FORBIDDEN");
    expect((await stored(a)).version).toBe(before);
  });

  test("another tenant's admin can neither read nor change it", async () => {
    expect(codeOf(await as(OTHER, POLICY, { t: a }))).toBe("FORBIDDEN");
    expect(
      codeOf(
        await as(OTHER, UPDATE, { t: a, i: { par: { required: false } } }),
      ),
    ).toBe("FORBIDDEN");
  });
});

describe("updateOAuthPolicy", () => {
  test("an owner turns PAR off and on: the version rises and each change is an admin event", async () => {
    const before = await stored(a);
    const off = await as(OWNER, UPDATE, {
      t: a,
      i: { par: { required: false } },
    });
    expect(off.data?.["updateOAuthPolicy"]).toMatchObject({
      par: { required: false },
      dpop: { required: false },
      version: before.version + 1,
    });
    const on = await as(OWNER, UPDATE, {
      t: a,
      i: { par: { required: true } },
    });
    expect(on.data?.["updateOAuthPolicy"]?.par.required).toBe(true);
    expect((await stored(a)).oauth.par.required).toBe(true);
    expect((await eventsOf(a)).length).toBe(2);
  });

  test("a call that changes nothing writes nothing but is still recorded", async () => {
    const before = await stored(a);
    const events = (await eventsOf(a)).length;
    const same = await as(OWNER, UPDATE, {
      t: a,
      i: { par: { required: true } },
    });
    expect(same.data?.["updateOAuthPolicy"]?.version).toBe(before.version);
    expect((await stored(a)).version).toBe(before.version);
    expect((await eventsOf(a)).length).toBe(events + 1);
  });

  test("a flag left out keeps its value", async () => {
    const result = await as(OWNER, UPDATE, {
      t: a,
      i: { dpop: { required: true } },
    });
    expect(result.data?.["updateOAuthPolicy"]).toMatchObject({
      par: { required: true },
      dpop: { required: true },
    });
    await as(OWNER, UPDATE, { t: a, i: { dpop: { required: false } } });
  });

  test("the platform tenant may require PAR and DPoP (the console pushes and proves), and relax them again", async () => {
    const platform = await mongo.db.tenants.raw.findOne({
      slug: PLATFORM_TENANT_SLUG,
    });
    if (platform === null) throw new Error("no platform tenant");
    const id = platform._id.toHexString();
    await access.grantTenant(id, PLATFORM_ADMIN, "admin");
    const before = await stored(id);
    const on = await as(PLATFORM_ADMIN, UPDATE, {
      t: id,
      i: { par: { required: true }, dpop: { required: true } },
    });
    expect(on.errors).toBeUndefined();
    expect((await stored(id)).oauth).toMatchObject({
      par: { required: true },
      dpop: { required: true },
    });
    // Restored: the other specs share this tenant.
    const off = await as(PLATFORM_ADMIN, UPDATE, {
      t: id,
      i: { par: { required: false }, dpop: { required: false } },
    });
    expect(off.errors).toBeUndefined();
    const after = await stored(id);
    expect(after.oauth).toEqual(before.oauth);
    expect(after.version).toBe(before.version + 2);
  });

  test("a tenant that does not exist is NOT_FOUND to the service, and a lost race is CONFLICT", async () => {
    const service = new OAuthPolicyService(tenantsService);
    const missing = await service
      .update("65f0000000000000000000aa", { par: { required: true } })
      .catch((error: unknown) => error);
    expect((missing as GraphQLError).extensions).toMatchObject({
      code: "NOT_FOUND",
    });
    const lost = new OAuthPolicyService({
      liveByIds: tenantsService.liveByIds.bind(tenantsService),
      updateOAuth: async () => {
        throw Object.create(OptimisticLockError.prototype);
      },
    } as unknown as typeof tenantsService);
    const refusal = await lost
      .update(b, { par: { required: false } })
      .catch((error: unknown) => error);
    expect((refusal as GraphQLError).extensions).toMatchObject({
      code: "CONFLICT",
      http: { status: 409 },
    });
  });
});
