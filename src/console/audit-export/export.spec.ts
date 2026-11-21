import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { access } from "@/config/access";
import { authEventsService } from "@/config/audit";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { createTestApp } from "~/app";
import { exportAs } from "~/console";

const admin = exportAs("exp-admin");
const viewer = exportAs("exp-viewer");
const stranger = exportAs("exp-stranger");

let tenantA = "";
let tenantB = "";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const adminEvent = (tenantId: string, action: string, at: Date) =>
  mongo.db.adminEvents.raw.insertOne({
    _id: new ObjectId(),
    actor: "exp-admin",
    action,
    tenantId: new ObjectId(tenantId),
    target: { type: "tenant", id: tenantId },
    at,
    requestId: "req",
  } as never);
const authEvent = (
  tenantId: string,
  userId: string,
  at: Date,
  ip = "198.51.100.4",
) =>
  authEventsService.record({
    kind: "auth",
    tenantId,
    type: "session.signIn",
    outcome: "success",
    method: "emailCode",
    userId,
    ip,
    userAgent: "Mozilla/5.0 Firefox/130.0",
    at,
  });

beforeAll(async () => {
  tenantA = (await tenantsService.create({ slug: "exp-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "exp-b", name: "B" })).id;
  await access.grantTenant(tenantA, "exp-admin", "admin");
  await access.grantTenant(tenantA, "exp-viewer", "viewer");
  await access.grantTenant(tenantB, "exp-stranger", "admin");
  for (let i = 0; i < 5; i += 1) {
    await adminEvent(tenantA, "tenant.update", daysAgo(i + 1));
    await authEvent(tenantA, `u${i}`, daysAgo(i + 1));
  }
  // Older than the free plan's 30 days: outside the retention.
  await adminEvent(tenantA, "tenant.old", daysAgo(45));
  await authEvent(tenantA, "old", daysAgo(45));
  await authEvent(tenantA, "=HYPERLINK(1)", daysAgo(0.5), "203.0.113.9");
  await authEvent(tenantB, "ub", daysAgo(1));
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.adminEvents.raw.deleteMany({});
  await mongo.db.authEvents.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

const lines = (text: string) => text.split("\n").filter((line) => line !== "");
// Earlier exports record `auditLog.export` in the same log: the seeded rows are the updates.
const updates = (text: string) =>
  lines(text).filter((line) => line.includes('"action":"tenant.update"'));

describe("formats", () => {
  test("CSV: a header, then the tenant's sign-ins newest first, with its headers", async () => {
    const response = await admin({
      tenantId: tenantA,
      log: "auth",
      format: "csv",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="clavix-auth-events-exp-a-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-clavix-export-truncated")).toBe("false");
    const rows = lines(await response.text());
    expect(rows[0]).toStartWith("id,at,type,outcome,reason,method");
    // 5 + the formula one; the 45-day-old and the other tenant's are out.
    expect(rows).toHaveLength(1 + 6);
    expect(rows.join("\n")).not.toContain("ub");
    expect(rows.join("\n")).not.toContain(",old,");
  });

  test("NDJSON: one JSON object per line", async () => {
    const response = await admin({
      tenantId: tenantA,
      log: "admin",
      format: "ndjson",
    });
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    const rows = updates(await response.text()).map((line) => JSON.parse(line));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      action: "tenant.update",
      actor: "exp-admin",
    });
    expect(rows.map((row) => row.at)).toEqual(
      [...rows.map((row) => row.at)].sort().reverse(),
    );
  });

  test("a formula cell is escaped", async () => {
    const text = await (
      await admin({ tenantId: tenantA, log: "auth", format: "csv" })
    ).text();
    expect(text).toContain(",'=HYPERLINK(1),");
    expect(text).not.toMatch(/,=HYPERLINK/);
  });
});

describe("range and limit", () => {
  test("the range is clamped to the plan's retention, and `from` narrows it", async () => {
    const wide = await admin({
      tenantId: tenantA,
      log: "admin",
      format: "ndjson",
      from: daysAgo(400).toISOString(),
    });
    expect(updates(await wide.text())).toHaveLength(5);
    const floor = Date.parse(wide.headers.get("x-clavix-export-from") ?? "");
    expect(Date.now() - floor).toBeGreaterThan(29.9 * DAY);
    expect(Date.now() - floor).toBeLessThan(30.1 * DAY);
    const narrow = await admin({
      tenantId: tenantA,
      log: "admin",
      format: "ndjson",
      from: daysAgo(2.5).toISOString(),
    });
    expect(updates(await narrow.text())).toHaveLength(2);
    const upTo = await admin({
      tenantId: tenantA,
      log: "admin",
      format: "ndjson",
      to: daysAgo(3.5).toISOString(),
    });
    expect(updates(await upTo.text())).toHaveLength(2);
  });

  test("an export holds at most the row limit, the newest rows, and says it was cut", async () => {
    const limited = exportAs("exp-admin", { maxRows: 3 });
    const response = await limited({
      tenantId: tenantA,
      log: "admin",
      format: "ndjson",
    });
    expect(response.headers.get("x-clavix-export-truncated")).toBe("true");
    const rows = lines(await response.text());
    expect(rows).toHaveLength(3);
  });

  test("a tenant over its export budget is a 429 with Retry-After, and records nothing", async () => {
    let spent = 0;
    const throttled = exportAs("exp-admin", {
      throttle: async () => (++spent > 1 ? 42 : null),
    });
    expect((await throttled({ tenantId: tenantA, log: "admin" })).status).toBe(
      200,
    );
    const before = await mongo.db.adminEvents.raw.countDocuments({
      action: "auditLog.export",
    });
    const refused = await throttled({ tenantId: tenantA, log: "admin" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("42");
    expect(
      await mongo.db.adminEvents.raw.countDocuments({
        action: "auditLog.export",
      }),
    ).toBe(before);
  });

  test("more rows than one batch stream whole", async () => {
    const many = exportAs("exp-admin", { maxRows: 2_000 });
    await mongo.db.authEvents.raw.insertMany(
      Array.from({ length: 1_200 }, (_, i) => ({
        _id: new ObjectId(),
        tenantId: new ObjectId(tenantB),
        type: "session.signIn",
        at: new Date(Date.now() - 1_000 - i),
        outcome: "success",
        reason: null,
        method: "emailCode",
        actor: { kind: "user", id: "bulk" },
        userId: "bulk",
        clientId: null,
        ip: null,
        userAgent: null,
        requestId: `r${i}`,
      })) as never,
    );
    await access.grantTenant(tenantB, "exp-admin", "admin");
    const response = await many({
      tenantId: tenantB,
      log: "auth",
      format: "ndjson",
    });
    expect(lines(await response.text())).toHaveLength(1_201);
  });
});

describe("guards and recording", () => {
  test("a viewer exports the console activity, not the sign-in log (D18)", async () => {
    expect((await viewer({ tenantId: tenantA, log: "admin" })).status).toBe(
      200,
    );
    expect((await viewer({ tenantId: tenantA, log: "auth" })).status).toBe(403);
  });

  test("another tenant's admin, and a stranger, are refused", async () => {
    expect((await stranger({ tenantId: tenantA, log: "admin" })).status).toBe(
      403,
    );
    expect(
      (await exportAs("nobody")({ tenantId: tenantA, log: "auth" })).status,
    ).toBe(403);
  });

  test("bad parameters are 400", async () => {
    for (const params of [
      { tenantId: "nope", log: "admin" },
      { tenantId: tenantA, log: "other" },
      { tenantId: tenantA, log: "admin", format: "xml" },
      { tenantId: tenantA, log: "admin", from: "yesterday" },
      { tenantId: tenantA, log: "admin", from: "2026-02-01", to: "2026-01-01" },
    ]) {
      expect((await admin(params)).status).toBe(400);
    }
  });

  test("no token is a 401 with a challenge; the other methods are refused", async () => {
    const app = createTestApp({
      console: {
        ...(await import("@/config/console")).createConsoleDeps({
          serverFor: async () => null,
        }),
        authenticate: async () => null,
      },
    });
    const url = `http://localhost/console/audit/export?tenantId=${tenantA}&log=admin`;
    const refused = await app.request(url);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain("Bearer");
    const post = await app.request(url, { method: "POST" });
    expect(post.status).toBe(405);
  });

  test("each export records auditLog.export, with its log and tenant", async () => {
    await mongo.db.adminEvents.raw.deleteMany({ action: "auditLog.export" });
    await (await admin({ tenantId: tenantA, log: "auth" })).text();
    await (await admin({ tenantId: tenantA, log: "admin" })).text();
    const events = await mongo.db.adminEvents.raw
      .find({ action: "auditLog.export" })
      .toArray();
    expect(events.map((event) => event.target)).toEqual(
      expect.arrayContaining([
        { type: "auditLog", id: "auth" },
        { type: "auditLog", id: "admin" },
      ]),
    );
    expect(events.every((event) => event.actor === "exp-admin")).toBe(true);
    expect(
      events.every((event) => event.tenantId?.toHexString() === tenantA),
    ).toBe(true);
    // A refused export records nothing.
    const before = await mongo.db.adminEvents.raw.countDocuments({
      action: "auditLog.export",
    });
    await viewer({ tenantId: tenantA, log: "auth" });
    expect(
      await mongo.db.adminEvents.raw.countDocuments({
        action: "auditLog.export",
      }),
    ).toBe(before);
  });
});
