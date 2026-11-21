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
import { CONSOLE_CLIENT_ID, CONSOLE_PATH } from "@/console/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { clientHeaders } from "~/client-header";
import { verifiedCallers } from "~/console";

const deps = createConsoleDeps({ serverFor: async () => null });
const OPERATOR = "switch-operator";
const PLATFORM_VIEWER = "switch-platform-viewer";
const MEMBER = "switch-member";
const MULTI = "switch-multi";
const OUTSIDER = "switch-outsider";
const HYBRID = "switch-hybrid";

interface GqlResult {
  // biome-ignore lint/suspicious/noExplicitAny: the spec reads untyped GraphQL JSON
  data?: Record<string, any> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}
const request = (userId: string | null, query: string) =>
  createApp({
    console: {
      ...verifiedCallers(deps),
      authenticate: async () =>
        userId === null
          ? null
          : {
              userId,
              clientId: CONSOLE_CLIENT_ID,
              grantId: "g",
              scopes: ["console"],
              clientName: null,
              bound: null,
              jkt: null,
              authorizationDetails: [],
            },
    },
  }).request(`http://localhost${CONSOLE_PATH}`, {
    method: "POST",
    headers: {
      ...clientHeaders,
      "content-type": "application/json",
      authorization: "Bearer x",
    },
    body: JSON.stringify({ query }),
  });
const as = async (userId: string, query: string) =>
  (await (await request(userId, query)).json()) as GqlResult;

const LIST = (args = "") =>
  `{ me { switchableTenants${args} { items { role tenant { slug name status } } nextCursor totalCount } } }`;
// biome-ignore lint/suspicious/noExplicitAny: untyped GraphQL JSON
const pageOf = (r: GqlResult): any => r.data?.["me"]?.switchableTenants;
const slugs = (r: GqlResult) =>
  (pageOf(r).items as { tenant: { slug: string } }[]).map((i) => i.tenant.slug);

const ids: Record<string, string> = {};
async function make(slug: string, name = `${slug} Inc`) {
  const tenant = await tenantsService.create({ slug, name, plan: "free" });
  ids[slug] = tenant._id.toHexString();
  return ids[slug] as string;
}

const clean = async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await oauthDb.collection("relations").deleteMany({});
};

beforeAll(clean);
afterAll(clean);
beforeEach(async () => {
  await clean();
  await access.grantPlatform(OPERATOR, "owner");
  await access.grantPlatform(PLATFORM_VIEWER, "viewer");
  const a = await make("sw-alpha", "Alpha");
  const b = await make("sw-beta", "Beta");
  await make("sw-gamma", "Gamma");
  await access.grantTenant(a, MEMBER, "admin");
  await access.grantTenant(a, MULTI, "viewer");
  await access.grantTenant(b, MULTI, "owner");
  await access.grantTenant(b, HYBRID, "viewer");
  await access.grantPlatform(HYBRID, "admin");
});

describe("Me.switchableTenants", () => {
  test("a member sees the tenant of their membership with their role", async () => {
    const r = await as(MEMBER, LIST());
    expect(r.errors).toBeUndefined();
    expect(pageOf(r)).toEqual({
      items: [
        {
          role: "ADMIN",
          tenant: { slug: "sw-alpha", name: "Alpha", status: "ACTIVE" },
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });
  });

  test("several memberships are listed by slug, each with its own role", async () => {
    const r = await as(MULTI, LIST());
    expect(pageOf(r).items).toMatchObject([
      { role: "VIEWER", tenant: { slug: "sw-alpha" } },
      { role: "OWNER", tenant: { slug: "sw-beta" } },
    ]);
  });

  test("tenant A's member never sees tenant B", async () => {
    expect(slugs(await as(MEMBER, LIST()))).toEqual(["sw-alpha"]);
  });

  test("a caller with no role gets an empty page", async () => {
    const r = await as(OUTSIDER, LIST());
    expect(r.errors).toBeUndefined();
    expect(pageOf(r)).toEqual({
      items: [],
      nextCursor: null,
      totalCount: 0,
    });
  });

  test("a platform operator with no membership sees every live tenant with the platform role", async () => {
    const r = await as(OPERATOR, LIST());
    expect(slugs(r)).toEqual(
      expect.arrayContaining(["sw-alpha", "sw-beta", "sw-gamma"]),
    );
    for (const item of pageOf(r).items) {
      expect(item.role).toBe("OWNER");
    }
    const viewer = await as(PLATFORM_VIEWER, LIST('(q: "sw-")'));
    expect(slugs(viewer)).toEqual(["sw-alpha", "sw-beta", "sw-gamma"]);
    expect(
      pageOf(viewer).items.every((i: { role: string }) => i.role === "VIEWER"),
    ).toBe(true);
  });

  test("an operator's role on a tenant is the stronger of the two", async () => {
    const r = await as(HYBRID, LIST('(q: "sw-")'));
    const byslug = Object.fromEntries(
      pageOf(r).items.map((i: { role: string; tenant: { slug: string } }) => [
        i.tenant.slug,
        i.role,
      ]),
    );
    expect(byslug).toEqual({
      "sw-alpha": "ADMIN",
      "sw-beta": "ADMIN",
      "sw-gamma": "ADMIN",
    });
  });

  test("a suspended tenant stays listed with its status, a deleted one is left out", async () => {
    await tenantsService.suspend(ids["sw-alpha"] as string);
    await tenantsService.trash(ids["sw-beta"] as string);
    const member = await as(MULTI, LIST());
    expect(pageOf(member).items).toMatchObject([
      { tenant: { slug: "sw-alpha", status: "SUSPENDED" } },
    ]);
    const operator = await as(OPERATOR, LIST('(q: "sw-")'));
    expect(
      pageOf(operator).items.map(
        (i: { tenant: { slug: string; status: string } }) => [
          i.tenant.slug,
          i.tenant.status,
        ],
      ),
    ).toEqual([
      ["sw-alpha", "SUSPENDED"],
      ["sw-gamma", "ACTIVE"],
    ]);
  });

  test("search matches the start of the slug or part of the name", async () => {
    expect(slugs(await as(OPERATOR, LIST('(q: "sw-be")')))).toEqual([
      "sw-beta",
    ]);
    expect(slugs(await as(OPERATOR, LIST('(q: "amm")')))).toEqual(["sw-gamma"]);
    expect(slugs(await as(MULTI, LIST('(q: "BET")')))).toEqual(["sw-beta"]);
    expect(slugs(await as(MULTI, LIST('(q: "gamma")')))).toEqual([]);
  });

  test("totalCount counts the caller's own tenants, whatever the page, and follows q", async () => {
    const count = async (who: string, args = "") =>
      pageOf(await as(who, LIST(args))).totalCount;
    // A member of one tenant never counts another's.
    expect(await count(MEMBER)).toBe(1);
    expect(await count(MULTI)).toBe(2);
    expect(await count(MULTI, '(q: "BET")')).toBe(1);
    expect(await count(MULTI, "(first: 1)")).toBe(2);
    expect(await count(OUTSIDER)).toBe(0);
    // An operator counts every live tenant, on page 2 as on page 1.
    const total = await count(OPERATOR, '(q: "sw-")');
    expect(total).toBe(3);
    const one = await as(OPERATOR, LIST('(q: "sw-", first: 2)'));
    const cursor = pageOf(one).nextCursor as string;
    expect(pageOf(one).totalCount).toBe(3);
    expect(
      await count(OPERATOR, `(q: "sw-", first: 2, after: "${cursor}")`),
    ).toBe(3);
  });

  test("an operator's page is cursor-paged", async () => {
    const one = await as(OPERATOR, LIST('(q: "sw-", first: 2)'));
    expect(slugs(one)).toEqual(["sw-alpha", "sw-beta"]);
    const cursor = pageOf(one).nextCursor as string;
    expect(cursor).toBeString();
    const two = await as(
      OPERATOR,
      LIST(`(q: "sw-", first: 2, after: "${cursor}")`),
    );
    expect(slugs(two)).toEqual(["sw-gamma"]);
    expect(pageOf(two).nextCursor).toBeNull();
  });

  test("a member's page is cursor-paged too", async () => {
    for (const n of ["a", "b", "c"]) {
      const id = await make(`sw-m-${n}`);
      await access.grantTenant(id, MEMBER, "viewer");
    }
    const one = await as(MEMBER, LIST("(first: 2)"));
    expect(slugs(one)).toEqual(["sw-alpha", "sw-m-a"]);
    const cursor = pageOf(one).nextCursor as string;
    const two = await as(MEMBER, LIST(`(first: 2, after: "${cursor}")`));
    expect(slugs(two)).toEqual(["sw-m-b", "sw-m-c"]);
    expect(pageOf(two).nextCursor).toBeNull();
  });

  test("a member's cursor is opaque, as an operator's is", async () => {
    const one = await as(MULTI, LIST("(first: 1)"));
    const cursor = pageOf(one).nextCursor as string;
    expect(cursor).toBeString();
    expect(cursor).not.toBe("sw-alpha");
    expect(
      slugs(await as(MULTI, LIST(`(first: 1, after: "${cursor}")`))),
    ).toEqual(["sw-beta"]);
  });

  test("first is held between 1 and 100, for a member and an operator", async () => {
    for (const who of [MULTI, OPERATOR]) {
      expect(slugs(await as(who, LIST('(q: "sw-", first: 0)')))).toHaveLength(
        1,
      );
      expect(slugs(await as(who, LIST('(q: "sw-", first: -5)')))).toHaveLength(
        1,
      );
      expect(
        slugs(await as(who, LIST('(q: "sw-", first: 100000)'))).length,
      ).toBeGreaterThan(1);
    }
  });

  test("a cursor that is not valid is BAD_USER_INPUT, for a member and an operator", async () => {
    for (const who of [MEMBER, OPERATOR]) {
      for (const after of ["sw-alpha", "!!not-a-cursor"]) {
        const r = await as(who, LIST(`(after: "${after}")`));
        expect(r.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
      }
    }
  });

  test("a cursor of one search is refused on another", async () => {
    const one = await as(MULTI, LIST("(first: 1)"));
    const cursor = pageOf(one).nextCursor as string;
    const r = await as(MULTI, LIST(`(q: "beta", after: "${cursor}")`));
    expect(r.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
  });

  test("a request with no valid token is a 401", async () => {
    expect((await request(null, LIST())).status).toBe(401);
  });
});
