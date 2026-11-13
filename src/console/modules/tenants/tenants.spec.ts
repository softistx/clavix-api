import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createApp } from "@/app";
import { access } from "@/config/access";
import { createConsoleDeps } from "@/config/console";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { CONSOLE_CLIENT_ID } from "@/console/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { CONSOLE_PATH } from "../../identity";

const deps = createConsoleDeps({ serverFor: async () => null });
const OPERATOR = "tenants-operator";
const VIEWER = "tenants-platform-viewer";
const ADMIN = "tenants-admin-acme";
const OUTSIDER = "tenants-outsider";

interface GqlResult {
  // biome-ignore lint/suspicious/noExplicitAny: the spec reads untyped GraphQL JSON
  data?: Record<string, any> | null;
  errors?: {
    message: string;
    extensions?: { code?: string; field?: string };
  }[];
}
const as = (userId: string, query: string) =>
  createApp({
    console: {
      ...deps,
      authenticate: async () => ({
        userId,
        clientId: CONSOLE_CLIENT_ID,
        grantId: "g",
        scopes: ["console"],
        clientName: null,
        bound: null,
      }),
    },
  })
    .request(`http://localhost${CONSOLE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer x",
      },
      body: JSON.stringify({ query }),
    })
    .then((r) => r.json() as Promise<GqlResult>);
const code = (r: GqlResult) => r.errors?.[0]?.extensions?.code;
const events = async () =>
  (await mongo.db.adminEvents.raw.find({}).sort({ _id: 1 }).toArray()).map(
    (e) => e["action"],
  );

const FIELDS =
  "id slug name status signUp plan { id } quotas { mau clients domains } quotaOverrides { mau clients domains } deletedAt purgeAt";

beforeAll(async () => {
  await access.grantPlatform(OPERATOR, "owner");
  await access.grantPlatform(VIEWER, "viewer");
});
beforeEach(async () => {
  await mongo.db.adminEvents.raw.deleteMany({});
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
});
afterAll(async () => {
  await mongo.db.adminEvents.raw.deleteMany({});
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await oauthDb.collection("relations").deleteMany({});
});

async function create(slug = "acme") {
  const r = await as(
    OPERATOR,
    `mutation { createTenant(input: { slug: "${slug}", name: "${slug} Inc" }) { ${FIELDS} } }`,
  );
  expect(r.errors).toBeUndefined();
  return r.data?.["createTenant"] as { id: string };
}

describe("createTenant", () => {
  test("makes a free, active, closed tenant and records tenant.create", async () => {
    const t = await create();
    expect(t).toMatchObject({
      slug: "acme",
      status: "ACTIVE",
      signUp: false,
      plan: { id: "free" },
      quotas: { mau: 1000, clients: 3, domains: 1 },
      deletedAt: null,
      purgeAt: null,
    });
    expect(await events()).toEqual(["tenant.create"]);
  });

  test("a repeat after a failed record returns the tenant and records the event once", async () => {
    const first = await create();
    await mongo.db.adminEvents.raw.deleteMany({}); // the record that failed
    const again = await create();
    expect(again.id).toBe(first.id);
    expect(await events()).toEqual(["tenant.create"]);
  });

  test("a taken slug is SLUG_TAKEN, a bad one and an unknown plan BAD_USER_INPUT", async () => {
    await create();
    const taken = await as(
      OPERATOR,
      'mutation { createTenant(input: { slug: "acme", name: "X" }) { id } }',
    );
    expect(code(taken)).toBe("SLUG_TAKEN");
    const bad = await as(
      OPERATOR,
      'mutation { createTenant(input: { slug: "-no-", name: "X" }) { id } }',
    );
    expect(bad.errors?.[0]?.extensions).toMatchObject({
      code: "BAD_USER_INPUT",
      field: "slug",
    });
    const plan = await as(
      OPERATOR,
      'mutation { createTenant(input: { slug: "beta", name: "B", plan: "gold" }) { id } }',
    );
    expect(plan.errors?.[0]?.extensions).toMatchObject({
      code: "BAD_USER_INPUT",
      field: "plan",
    });
  });

  test("a platform viewer and an outsider cannot create", async () => {
    for (const user of [VIEWER, OUTSIDER]) {
      const r = await as(
        user,
        'mutation { createTenant(input: { slug: "nope", name: "N" }) { id } }',
      );
      expect(code(r)).toBe("FORBIDDEN");
    }
    expect(await tenantsService.activeByIds([])).toEqual([]);
  });
});

describe("plan and quotas", () => {
  test("setTenantPlan replaces the overrides and is idempotent", async () => {
    const { id } = await create();
    const run = () =>
      as(
        OPERATOR,
        `mutation { setTenantPlan(id: "${id}", input: { plan: "pro", quotaOverrides: { clients: 50 } }) { ${FIELDS} } }`,
      );
    const first = await run();
    expect(first.data?.["setTenantPlan"]).toMatchObject({
      plan: { id: "pro" },
      quotaOverrides: { mau: null, clients: 50, domains: null },
      quotas: { mau: 10000, clients: 50, domains: 5 },
    });
    const second = await run();
    expect(second.data).toEqual(first.data);
    const reset = await as(
      OPERATOR,
      `mutation { setTenantPlan(id: "${id}", input: { plan: "free" }) { quotaOverrides { clients } quotas { clients } } }`,
    );
    expect(reset.data?.["setTenantPlan"]).toEqual({
      quotaOverrides: { clients: null },
      quotas: { clients: 3 },
    });
  });

  test("a negative override is BAD_USER_INPUT; plans lists the three plans", async () => {
    const { id } = await create();
    const bad = await as(
      OPERATOR,
      `mutation { setTenantPlan(id: "${id}", input: { plan: "free", quotaOverrides: { mau: -1 } }) { id } }`,
    );
    expect(code(bad)).toBe("BAD_USER_INPUT");
    const plans = await as(OUTSIDER, "{ plans { id } }");
    expect(plans.data?.["plans"]).toEqual([
      { id: "free" },
      { id: "pro" },
      { id: "enterprise" },
    ]);
  });
});

describe("suspend, resume, delete, restore", () => {
  test("suspend and resume are idempotent and recorded", async () => {
    const { id } = await create();
    for (let i = 0; i < 2; i++) {
      const r = await as(
        OPERATOR,
        `mutation { suspendTenant(id: "${id}") { status } }`,
      );
      expect(r.data?.["suspendTenant"]).toEqual({ status: "SUSPENDED" });
    }
    const resumed = await as(
      OPERATOR,
      `mutation { resumeTenant(id: "${id}") { status } }`,
    );
    expect(resumed.data?.["resumeTenant"]).toEqual({ status: "ACTIVE" });
    expect((await events()).filter((e) => e === "tenant.suspend")).toHaveLength(
      2,
    );
  });

  test("the clavix tenant is PLATFORM_TENANT_PROTECTED", async () => {
    const platform = await mongo.db.tenants.findFirst({
      slug: PLATFORM_TENANT_SLUG,
    });
    const id = platform?._id.toHexString();
    for (const op of ["suspendTenant", "deleteTenant"]) {
      const r = await as(OPERATOR, `mutation { ${op}(id: "${id}") { id } }`);
      expect(code(r)).toBe("PLATFORM_TENANT_PROTECTED");
    }
  });

  test("delete and restore take the id in upper case too", async () => {
    const { id } = await create();
    const del = await as(
      OPERATOR,
      `mutation { deleteTenant(id: "${id.toUpperCase()}") { status } }`,
    );
    expect(del.errors).toBeUndefined();
    const res = await as(
      OPERATOR,
      `mutation { restoreTenant(id: "${id.toUpperCase()}") { status } }`,
    );
    expect(res.errors).toBeUndefined();
  });

  test("delete puts the tenant in the trash with a purgeAt 30 days on; restore brings back its status", async () => {
    const { id } = await create();
    await as(OPERATOR, `mutation { suspendTenant(id: "${id}") { id } }`);
    const first = await as(
      OPERATOR,
      `mutation { deleteTenant(id: "${id}") { status deletedAt purgeAt } }`,
    );
    const d = first.data?.["deleteTenant"];
    expect(d.status).toBe("DELETED");
    expect(
      new Date(d.purgeAt).getTime() - new Date(d.deletedAt).getTime(),
    ).toBe(30 * 24 * 60 * 60 * 1000);
    const again = await as(
      OPERATOR,
      `mutation { deleteTenant(id: "${id}") { deletedAt } }`,
    );
    expect(again.data?.["deleteTenant"].deletedAt).toBe(d.deletedAt);
    // The trash is resumed by restore, not resume.
    const resume = await as(
      OPERATOR,
      `mutation { resumeTenant(id: "${id}") { id } }`,
    );
    expect(code(resume)).toBe("NOT_FOUND");
    const restored = await as(
      OPERATOR,
      `mutation { restoreTenant(id: "${id}") { status deletedAt purgeAt } }`,
    );
    expect(restored.data?.["restoreTenant"]).toEqual({
      status: "SUSPENDED",
      deletedAt: null,
      purgeAt: null,
    });
    const slug = await as(
      OPERATOR,
      'mutation { createTenant(input: { slug: "acme", name: "again" }) { id } }',
    );
    expect(code(slug)).toBe("SLUG_TAKEN");
  });

  test("a deleted tenant keeps its slug reserved", async () => {
    const { id } = await create();
    await as(OPERATOR, `mutation { deleteTenant(id: "${id}") { id } }`);
    const again = await as(
      OPERATOR,
      'mutation { createTenant(input: { slug: "acme", name: "new" }) { id } }',
    );
    expect(code(again)).toBe("SLUG_TAKEN");
  });
});

describe("queries", () => {
  test("tenants lists by slug, searches, filters by status and pages", async () => {
    const a = await create("alpha");
    await create("bravo");
    await create("charlie");
    await as(OPERATOR, `mutation { deleteTenant(id: "${a.id}") { id } }`);
    const all = await as(
      OPERATOR,
      "{ tenants(first: 2) { items { slug status } nextCursor totalCount } }",
    );
    const page = all.data?.["tenants"];
    expect(page.items.map((t: { slug: string }) => t.slug)).toEqual([
      "alpha",
      "bravo",
    ]);
    expect(page.items[0].status).toBe("DELETED");
    const next = await as(
      OPERATOR,
      `{ tenants(first: 2, after: "${page.nextCursor}") { items { slug } nextCursor } }`,
    );
    expect(
      next.data?.["tenants"].items.map((t: { slug: string }) => t.slug),
    ).toEqual(["charlie", PLATFORM_TENANT_SLUG].sort());
    // totalCount ignores the page and the cursor, and follows q and status.
    expect(page.totalCount).toBe(4);
    const second = await as(
      OPERATOR,
      `{ tenants(first: 2, after: "${page.nextCursor}") { totalCount } }`,
    );
    expect(second.data?.["tenants"].totalCount).toBe(4);
    const counted = await as(
      OPERATOR,
      '{ a: tenants(q: "BRA") { totalCount } b: tenants(status: DELETED) { totalCount } c: tenants(q: "zzz") { totalCount } }',
    );
    expect(counted.data).toEqual({
      a: { totalCount: 1 },
      b: { totalCount: 1 },
      c: { totalCount: 0 },
    });
    const q = await as(OPERATOR, '{ tenants(q: "BRA") { items { slug } } }');
    expect(q.data?.["tenants"].items).toEqual([{ slug: "bravo" }]);
    const deleted = await as(
      OPERATOR,
      "{ tenants(status: DELETED) { items { slug } } }",
    );
    expect(deleted.data?.["tenants"].items).toEqual([{ slug: "alpha" }]);
  });

  test("tenants needs view on the platform; a tenant admin sees only its tenant, not the trash", async () => {
    const { id } = await create();
    await access.grantTenant(id, ADMIN, "admin");
    expect(code(await as(ADMIN, "{ tenants { items { id } } }"))).toBe(
      "FORBIDDEN",
    );
    expect(
      code(await as(VIEWER, "{ tenants { items { id } } }")),
    ).toBeUndefined();
    const one = await as(ADMIN, `{ tenant(id: "${id}") { slug } }`);
    expect(one.data?.["tenant"]).toEqual({ slug: "acme" });
    await as(OPERATOR, `mutation { deleteTenant(id: "${id}") { id } }`);
    const hidden = await as(ADMIN, `{ tenant(id: "${id}") { slug } }`);
    expect(hidden.data?.["tenant"]).toBeNull();
    const seen = await as(OPERATOR, `{ tenant(id: "${id}") { status } }`);
    expect(seen.data?.["tenant"]).toEqual({ status: "DELETED" });
  });

  test("a tenant admin's update is refused while suspended; an operator's goes through", async () => {
    const { id } = await create();
    await access.grantTenant(id, ADMIN, "admin");
    const ok = await as(
      ADMIN,
      `mutation { updateTenant(id: "${id}", input: { name: "Renamed", signUp: true }) { name signUp } }`,
    );
    expect(ok.data?.["updateTenant"]).toEqual({
      name: "Renamed",
      signUp: true,
    });
    await as(OPERATOR, `mutation { suspendTenant(id: "${id}") { id } }`);
    const refused = await as(
      ADMIN,
      `mutation { updateTenant(id: "${id}", input: { name: "Again" }) { name } }`,
    );
    expect(code(refused)).toBe("TENANT_SUSPENDED");
    const op = await as(
      OPERATOR,
      `mutation { updateTenant(id: "${id}", input: { name: "Again" }) { name } }`,
    );
    expect(op.data?.["updateTenant"]).toEqual({ name: "Again" });
  });

  test("usage reports the meters against the quotas; a bad month is BAD_USER_INPUT", async () => {
    const { id } = await create();
    await access.grantTenant(id, ADMIN, "viewer");
    const r = await as(
      ADMIN,
      `{ usage(tenantId: "${id}", month: "2026-10") { tenantId month mau { used quota exceeded } clients { used quota } domains { used quota } } }`,
    );
    expect(r.data?.["usage"]).toEqual({
      tenantId: id,
      month: "2026-10",
      mau: { used: 0, quota: 1000, exceeded: false },
      clients: { used: 0, quota: 3 },
      domains: { used: 0, quota: 1 },
    });
    // The id in upper case is the same tenant (the guard and the read agree).
    const upper = await as(
      ADMIN,
      `{ usage(tenantId: "${id.toUpperCase()}", month: "2026-10") { month } }`,
    );
    expect(upper.errors).toBeUndefined();
    expect(upper.data?.["usage"]).toEqual({ month: "2026-10" });
    const bad = await as(
      ADMIN,
      `{ usage(tenantId: "${id}", month: "2026-13") { month } }`,
    );
    expect(bad.errors?.[0]?.extensions).toMatchObject({
      code: "BAD_USER_INPUT",
      field: "month",
    });
    expect(
      code(await as(OUTSIDER, `{ usage(tenantId: "${id}") { month } }`)),
    ).toBe("FORBIDDEN");
  });
});
