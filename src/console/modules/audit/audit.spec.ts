import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { access } from "@/config/access";
import { authEventsService } from "@/config/audit";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { codeOf, consoleAs } from "~/console";

const owner = consoleAs("aud-owner-a");
const admin = consoleAs("aud-admin-a");
const viewer = consoleAs("aud-viewer-a");
const adminB = consoleAs("aud-admin-b");
const stranger = consoleAs("aud-stranger");
const operator = consoleAs("aud-operator");

let tenantA = "";
let tenantB = "";

const ADMIN_EVENTS = `query($tenantId: ID!, $filter: AdminEventFilter, $first: Int, $after: String) {
  adminEvents(tenantId: $tenantId, filter: $filter, first: $first, after: $after) {
    totalCount nextCursor
    items { id action tenantId at requestId target { type id } actor { kind id name email } }
  }
}`;
const AUTH_EVENTS = `query($tenantId: ID!, $filter: AuthEventFilter, $first: Int, $after: String) {
  authEvents(tenantId: $tenantId, filter: $filter, first: $first, after: $after) {
    totalCount nextCursor
    items { id type at outcome reason method ip userAgent userId actor { kind id name email } }
  }
}`;
const PLATFORM = `query($filter: AdminEventFilter, $first: Int) {
  platformAdminEvents(filter: $filter, first: $first) {
    totalCount items { action tenantId }
  }
}`;

const pageOf = (result: Awaited<ReturnType<typeof admin>>, key: string) =>
  (result.data?.[key] ?? {}) as Record<string, unknown>;
const totalOf = (result: Awaited<ReturnType<typeof admin>>) =>
  Object.values(result.data ?? {}).map(
    (page) => (page as { totalCount: number }).totalCount,
  )[0];

const T0 = new Date("2026-11-10T10:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const adminEvent = (
  tenantId: string | null,
  action: string,
  actor: string,
  at: Date,
) =>
  mongo.db.adminEvents.raw.insertOne({
    _id: new ObjectId(),
    actor,
    action,
    tenantId: tenantId === null ? null : new ObjectId(tenantId),
    target: { type: "tenant", id: tenantId ?? "platform" },
    at,
    requestId: "req",
  } as never);
const authEvent = (
  tenantId: string,
  over: Partial<Parameters<typeof authEventsService.record>[0]>,
) =>
  authEventsService.record({
    kind: "auth",
    tenantId,
    type: "session.signIn",
    outcome: "success",
    method: "emailCode",
    userId: "someone",
    ip: "198.51.100.4",
    userAgent: "Mozilla/5.0 Firefox/130.0",
    at: minutes(0),
    ...over,
  });

beforeAll(async () => {
  tenantA = (await tenantsService.create({ slug: "aud-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "aud-b", name: "B" })).id;
  await access.grantTenant(tenantA, "aud-owner-a", "owner");
  await access.grantTenant(tenantA, "aud-admin-a", "admin");
  await access.grantTenant(tenantA, "aud-viewer-a", "viewer");
  await access.grantTenant(tenantB, "aud-admin-b", "admin");
  await access.grantPlatform("aud-operator", "owner");
  for (let i = 0; i < 5; i += 1) {
    await adminEvent(
      tenantA,
      i % 2 === 0 ? "tenant.update" : "domain.add",
      i < 3 ? "aud-admin-a" : "aud-owner-a",
      minutes(i),
    );
  }
  await adminEvent(tenantB, "tenant.update", "aud-admin-b", minutes(1));
  await adminEvent(null, "tenant.create", "aud-operator", minutes(2));
  await authEvent(tenantA, { at: minutes(0), userId: "u1" });
  await authEvent(tenantA, {
    at: minutes(1),
    userId: "u2",
    outcome: "failure",
    reason: "CODE_INVALID",
  });
  await authEvent(tenantA, {
    at: minutes(2),
    userId: "u1",
    type: "passkey.added",
    method: undefined,
  });
  await authEvent(tenantB, { at: minutes(3), userId: "ub" });
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.adminEvents.raw.deleteMany({});
  await mongo.db.authEvents.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

describe("guards", () => {
  test("a viewer reads the console activity, not the sign-in log (D18)", async () => {
    expect(
      (await viewer(ADMIN_EVENTS, { tenantId: tenantA })).errors,
    ).toBeUndefined();
    expect(codeOf(await viewer(AUTH_EVENTS, { tenantId: tenantA }))).toBe(
      "FORBIDDEN",
    );
  });

  test("admins and owners read both logs", async () => {
    for (const caller of [admin, owner]) {
      expect(
        (await caller(ADMIN_EVENTS, { tenantId: tenantA })).errors,
      ).toBeUndefined();
      expect(
        (await caller(AUTH_EVENTS, { tenantId: tenantA })).errors,
      ).toBeUndefined();
    }
  });

  test("a stranger and another tenant's admin read nothing", async () => {
    for (const caller of [stranger, adminB]) {
      expect(codeOf(await caller(ADMIN_EVENTS, { tenantId: tenantA }))).toBe(
        "FORBIDDEN",
      );
      expect(codeOf(await caller(AUTH_EVENTS, { tenantId: tenantA }))).toBe(
        "FORBIDDEN",
      );
    }
  });

  test("only an operator reads the platform's log", async () => {
    expect(codeOf(await admin(PLATFORM))).toBe("FORBIDDEN");
    expect((await operator(PLATFORM)).errors).toBeUndefined();
  });

  test("an operator reads any tenant's logs", async () => {
    const events = await operator(ADMIN_EVENTS, { tenantId: tenantB });
    expect(events.errors).toBeUndefined();
    expect(
      (await operator(AUTH_EVENTS, { tenantId: tenantB })).errors,
    ).toBeUndefined();
  });
});

describe("adminEvents", () => {
  test("a tenant sees only its own events, newest first", async () => {
    const result = await admin(ADMIN_EVENTS, { tenantId: tenantA });
    const page = result.data?.["adminEvents"] as {
      totalCount: number;
      items: { tenantId: string; at: string }[];
    };
    expect(page.totalCount).toBe(5);
    expect(page.items.every((item) => item.tenantId === tenantA)).toBe(true);
    expect(page.items.map((item) => item.at)).toEqual(
      [4, 3, 2, 1, 0].map((n) => minutes(n).toISOString()),
    );
  });

  test("pages with a cursor, and `totalCount` is the whole filtered count", async () => {
    const first = (await admin(ADMIN_EVENTS, { tenantId: tenantA, first: 2 }))
      .data?.["adminEvents"] as {
      totalCount: number;
      nextCursor: string;
      items: unknown[];
    };
    expect(first.items).toHaveLength(2);
    expect(first.totalCount).toBe(5);
    const next = (
      await admin(ADMIN_EVENTS, {
        tenantId: tenantA,
        first: 2,
        after: first.nextCursor,
      })
    ).data?.["adminEvents"] as { items: { at: string }[] };
    expect(next.items.map((item) => item.at)).toEqual([
      minutes(2).toISOString(),
      minutes(1).toISOString(),
    ]);
  });

  test("filters by action, actor and range", async () => {
    const count = async (filter: Record<string, unknown>) =>
      totalOf(await admin(ADMIN_EVENTS, { tenantId: tenantA, filter }));
    expect(await count({ action: "domain.add" })).toBe(2);
    expect(await count({ actor: "aud-owner-a" })).toBe(2);
    expect(
      await count({
        from: minutes(1).toISOString(),
        to: minutes(3).toISOString(),
      }),
    ).toBe(3);
    expect(await count({ action: "domain.add", actor: "aud-owner-a" })).toBe(1);
  });

  test("an actor is resolved to a name and an address when the user exists", async () => {
    const result = await admin(ADMIN_EVENTS, { tenantId: tenantA, first: 1 });
    const [item] = (
      pageOf(result, "adminEvents") as {
        items: { actor: { kind: string; id: string; name: string | null } }[];
      }
    ).items;
    expect(item?.actor).toMatchObject({ kind: "user", id: "aud-owner-a" });
    expect(item?.actor.name).toBeNull(); // no such user in the clavix tenant
  });

  test("an unknown tenant is refused by the guard (FORBIDDEN), a bad cursor BAD_USER_INPUT", async () => {
    expect(
      codeOf(
        await operator(ADMIN_EVENTS, {
          tenantId: new ObjectId().toHexString(),
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      codeOf(
        await admin(ADMIN_EVENTS, { tenantId: tenantA, after: "garbage!" }),
      ),
    ).toBe("BAD_USER_INPUT");
  });

  test("`first` is capped at 100 and floored at 1", async () => {
    const page = (await admin(ADMIN_EVENTS, { tenantId: tenantA, first: 0 }))
      .data?.["adminEvents"] as { items: unknown[] };
    expect(page.items).toHaveLength(1);
    expect(
      (await admin(ADMIN_EVENTS, { tenantId: tenantA, first: 500 })).errors,
    ).toBeUndefined();
  });
});

describe("authEvents", () => {
  test("a tenant sees only its own sign-in events, with the address (D15)", async () => {
    const result = await admin(AUTH_EVENTS, { tenantId: tenantA });
    const page = result.data?.["authEvents"] as {
      totalCount: number;
      items: { userId: string; ip: string; userAgent: string }[];
    };
    expect(page.totalCount).toBe(3);
    expect(page.items.map((item) => item.userId)).toEqual(["u1", "u2", "u1"]);
    expect(page.items[0]?.ip).toBe("198.51.100.4");
    expect(page.items[0]?.userAgent).toBe("Firefox");
  });

  test("filters by user, outcome, types and range", async () => {
    const count = async (filter: Record<string, unknown>) =>
      totalOf(await admin(AUTH_EVENTS, { tenantId: tenantA, filter }));
    expect(await count({ userId: "u1" })).toBe(2);
    expect(await count({ outcome: "failure" })).toBe(1);
    expect(await count({ types: ["passkey.added"] })).toBe(1);
    expect(await count({ types: ["passkey.added", "session.signIn"] })).toBe(3);
    expect(await count({ from: minutes(1).toISOString() })).toBe(2);
  });

  test("a type outside the closed list is BAD_USER_INPUT", async () => {
    expect(
      codeOf(
        await admin(AUTH_EVENTS, {
          tenantId: tenantA,
          filter: { types: ["nope.nope"] },
        }),
      ),
    ).toBe("BAD_USER_INPUT");
  });

  test("tenant B's events never show under A, whatever the filter", async () => {
    const result = await admin(AUTH_EVENTS, {
      tenantId: tenantA,
      filter: { userId: "ub" },
    });
    expect(totalOf(result)).toBe(0);
  });
});

describe("platformAdminEvents", () => {
  test("covers every tenant and the platform's own events", async () => {
    const page = (await operator(PLATFORM, { first: 100 })).data?.[
      "platformAdminEvents"
    ] as { totalCount: number; items: { tenantId: string | null }[] };
    expect(page.totalCount).toBe(7);
    expect(page.items.some((item) => item.tenantId === null)).toBe(true);
    expect(page.items.some((item) => item.tenantId === tenantB)).toBe(true);
  });

  test("filters by action", async () => {
    const page = (
      await operator(PLATFORM, { filter: { action: "tenant.create" } })
    ).data?.["platformAdminEvents"] as { totalCount: number };
    expect(page.totalCount).toBe(1);
  });
});

describe("adminEvent and authEvent", () => {
  const ONE_ADMIN = `query($tenantId: ID!, $id: ID!) {
    adminEvent(tenantId: $tenantId, id: $id) { id action tenantId actor { id } }
  }`;
  const ONE_AUTH = `query($tenantId: ID!, $id: ID!) {
    authEvent(tenantId: $tenantId, id: $id) { id type userId }
  }`;
  const idOf = async (
    collection: "adminEvents" | "authEvents",
    tenant: string,
  ) => {
    const found = await mongo.db[collection].raw.findOne({
      tenantId: new ObjectId(tenant),
    });
    if (found === null) throw new Error(`no seeded ${collection} event`);
    return found._id.toHexString();
  };

  test("reads one event of the tenant by id", async () => {
    const a = await admin(ONE_ADMIN, {
      tenantId: tenantA,
      id: await idOf("adminEvents", tenantA),
    });
    expect((pageOf(a, "adminEvent") as { tenantId: string }).tenantId).toBe(
      tenantA,
    );
    const b = await admin(ONE_AUTH, {
      tenantId: tenantA,
      id: await idOf("authEvents", tenantA),
    });
    expect(b.errors).toBeUndefined();
    expect((pageOf(b, "authEvent") as { id: string }).id).toBeString();
  });

  test("another tenant's event, an unknown id and a malformed id are all null", async () => {
    const otherAdmin = await idOf("adminEvents", tenantB);
    const otherAuth = await idOf("authEvents", tenantB);
    for (const id of [otherAdmin, "5f0000000000000000000000", "not-an-id"]) {
      const result = await admin(ONE_ADMIN, { tenantId: tenantA, id });
      expect(result.errors).toBeUndefined();
      expect(result.data?.["adminEvent"]).toBeNull();
    }
    for (const id of [otherAuth, "5f0000000000000000000000", "not-an-id"]) {
      const result = await admin(ONE_AUTH, { tenantId: tenantA, id });
      expect(result.errors).toBeUndefined();
      expect(result.data?.["authEvent"]).toBeNull();
    }
  });

  test("keeps the list permissions: a viewer reads no sign-in event, a stranger nothing", async () => {
    const adminId = await idOf("adminEvents", tenantA);
    const authId = await idOf("authEvents", tenantA);
    expect(
      (await viewer(ONE_ADMIN, { tenantId: tenantA, id: adminId })).errors,
    ).toBeUndefined();
    expect(
      codeOf(await viewer(ONE_AUTH, { tenantId: tenantA, id: authId })),
    ).toBe("FORBIDDEN");
    expect(
      codeOf(await stranger(ONE_ADMIN, { tenantId: tenantA, id: adminId })),
    ).toBe("FORBIDDEN");
    expect(
      codeOf(await adminB(ONE_AUTH, { tenantId: tenantA, id: authId })),
    ).toBe("FORBIDDEN");
  });

  test("an operator reads any console event by id, nobody else", async () => {
    const ONE = `query($id: ID!) { platformAdminEvent(id: $id) { id tenantId } }`;
    const id = await idOf("adminEvents", tenantB);
    const found = await operator(ONE, { id });
    expect((pageOf(found, "platformAdminEvent") as { id: string }).id).toBe(id);
    expect(
      (await operator(ONE, { id: "5f0000000000000000000000" })).data?.[
        "platformAdminEvent"
      ],
    ).toBeNull();
    expect(codeOf(await admin(ONE, { id }))).toBe("FORBIDDEN");
  });
});
