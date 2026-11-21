import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ObjectId } from "mongodb";
import { adminEventReader } from "@/config/admin-events";
import { authEventsService } from "@/config/audit";
import { mongo } from "@/config/db";
import { eventBus, eventFailures } from "@/config/events";
import { tenantsService } from "@/config/tenancy";
import { purgeAtOf } from "@/modules/tenants";
import { DAY, run, seed, useTenantPurgeHooks } from "~/tenant-purge";
import { enforceRetention } from "./retention";

useTenantPurgeHooks();
afterEach(async () => {
  await mongo.db.authEvents.raw.deleteMany({});
});

const NOW = new Date("2026-11-18T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const idOf = (tenant: { _id: ObjectId }) => tenant._id.toHexString();

const record = (tenantId: string, days: number, userId = "u1") =>
  authEventsService.record({
    kind: "auth",
    tenantId,
    type: "session.signIn",
    outcome: "success",
    method: "emailCode",
    userId,
    ip: "203.0.113.7",
    userAgent: "curl/8.4.0",
    at: ago(days),
  });
const adminEvent = (tenantId: ObjectId | null, days: number) =>
  mongo.db.adminEvents.raw.insertOne({
    _id: new ObjectId(),
    actor: "op",
    action: "tenant.update",
    tenantId,
    target: { type: "tenant", id: "x" },
    at: ago(days),
    requestId: "r",
  } as never);
const deps = () => ({
  targets: () => tenantsService.retentionTargets(),
  deleteAuthBefore: (id: string, before: Date) =>
    authEventsService.deleteBefore(id, before),
  deleteAdminBefore: (id: string | null, before: Date) =>
    adminEventReader.deleteBefore(id, before),
  log: () => {},
});
const authCount = (tenant: { _id: ObjectId }) =>
  mongo.db.authEvents.raw.countDocuments({ tenantId: tenant._id });
const adminCount = (tenantId: ObjectId | null) =>
  mongo.db.adminEvents.raw.countDocuments({ tenantId });

describe("the sign-in log", () => {
  test("an event keeps who, how, from where, and a user-agent family only", async () => {
    const a = await seed("auditone");
    await record(idOf(a), 0);
    const [stored] = await mongo.db.authEvents.raw
      .find({ tenantId: a._id })
      .toArray();
    expect(stored).toMatchObject({
      type: "session.signIn",
      outcome: "success",
      method: "emailCode",
      actor: { kind: "user", id: "u1" },
      userId: "u1",
      ip: "203.0.113.7",
      userAgent: "curl",
    });
    expect(JSON.stringify(stored)).not.toContain("8.4.0");
  });

  test("a failed sign-in naming nobody is attributed to `anonymous`", async () => {
    const a = await seed("auditanon");
    await authEventsService.record({
      kind: "auth",
      tenantId: idOf(a),
      type: "session.signIn",
      outcome: "failure",
      reason: "CODE_INVALID",
      method: "emailCode",
    });
    const page = await authEventsService.page(
      idOf(a),
      { outcome: "failure" },
      { after: null, limit: 10 },
    );
    expect(page.items[0]?.actor).toEqual({ kind: "user", id: "anonymous" });
    expect(page.items[0]?.reason).toBe("CODE_INVALID");
  });

  test("tenant A's events are unknown to B", async () => {
    const a = await seed("isoa");
    const b = await seed("isob");
    await record(idOf(a), 1);
    const forB = await authEventsService.page(
      idOf(b),
      {},
      { after: null, limit: 10 },
    );
    expect(forB).toEqual({ items: [], nextCursor: null, totalCount: 0 });
  });

  test("pages newest first with a cursor and a total, and filters narrow it", async () => {
    const a = await seed("paging");
    for (const [days, user] of [
      [5, "u1"],
      [4, "u2"],
      [3, "u1"],
      [2, "u2"],
      [1, "u1"],
    ] as const) {
      await record(idOf(a), days, user);
    }
    const first = await authEventsService.page(
      idOf(a),
      {},
      { after: null, limit: 2 },
    );
    expect(first.totalCount).toBe(5);
    expect(first.items.map((e) => e.at)).toEqual([ago(1), ago(2)]);
    expect(first.nextCursor).not.toBeNull();
    const second = await authEventsService.page(
      idOf(a),
      {},
      { after: first.nextCursor, limit: 2 },
    );
    expect(second.items.map((e) => e.at)).toEqual([ago(3), ago(4)]);

    const byUser = await authEventsService.page(
      idOf(a),
      { userId: "u1" },
      { after: null, limit: 10 },
    );
    expect(byUser.totalCount).toBe(3);
    const byRange = await authEventsService.page(
      idOf(a),
      { from: ago(3), to: ago(2) },
      { after: null, limit: 10 },
    );
    expect(byRange.items).toHaveLength(2);
    const byType = await authEventsService.page(
      idOf(a),
      { types: ["passkey.added"] },
      { after: null, limit: 10 },
    );
    expect(byType.totalCount).toBe(0);
  });
});

describe("a recorder failure", () => {
  test("never fails the emitter: it is counted and the event is lost", async () => {
    const a = await seed("downrec");
    const broken = spyOn(authEventsService, "record").mockRejectedValue(
      new Error("mongo down"),
    );
    const log = spyOn(console, "error").mockImplementation(() => {});
    const before = eventFailures.count;
    await expect(
      eventBus.emit({
        kind: "auth",
        tenantId: idOf(a),
        type: "session.signIn",
        outcome: "success",
        userId: "u1",
      }),
    ).resolves.toBeUndefined();
    expect(eventFailures.count).toBe(before + 1);
    broken.mockRestore();
    log.mockRestore();
    expect(await authCount(a)).toBe(0);
  });
});

describe("the retention", () => {
  test("cuts each tenant's logs at its plan's retention", async () => {
    const free = await seed("retfree");
    const pro = await seed("retpro");
    const enterprise = await seed("retent");
    await tenantsService.setPlan(idOf(pro), {
      plan: "pro",
      quotaOverrides: {},
    });
    await tenantsService.setPlan(idOf(enterprise), {
      plan: "enterprise",
      quotaOverrides: {},
    });
    for (const tenant of [free, pro, enterprise]) {
      for (const days of [10, 60, 200, 500]) {
        await record(idOf(tenant), days);
        await adminEvent(tenant._id, days);
      }
    }
    const report = await enforceRetention(deps(), NOW);
    expect(report.failed).toBe(0);
    // free 30 days: 10 stays; pro 90: 10 and 60; enterprise 365: up to 200.
    expect(await authCount(free)).toBe(1);
    expect(await authCount(pro)).toBe(2);
    expect(await authCount(enterprise)).toBe(3);
    expect(await adminCount(free._id)).toBe(1);
    expect(await adminCount(pro._id)).toBe(2);
    expect(await adminCount(enterprise._id)).toBe(3);
    expect(report.removed).toBe(2 * (3 + 2 + 1));
  });

  test("a plan change applies at the next run, in both directions", async () => {
    const tenant = await seed("retplan");
    await record(idOf(tenant), 60);
    await tenantsService.setPlan(idOf(tenant), {
      plan: "pro",
      quotaOverrides: {},
    });
    await enforceRetention(deps(), NOW);
    expect(await authCount(tenant)).toBe(1); // pro keeps 90 days
    await tenantsService.setPlan(idOf(tenant), {
      plan: "free",
      quotaOverrides: {},
    });
    await enforceRetention(deps(), NOW);
    expect(await authCount(tenant)).toBe(0); // free keeps 30
  });

  test("the platform's own events go at 400 days, and a second run removes nothing", async () => {
    await adminEvent(null, 399);
    await adminEvent(null, 401);
    const first = await enforceRetention(deps(), NOW);
    expect(first.removed).toBe(1);
    expect(await adminCount(null)).toBe(1);
    expect((await enforceRetention(deps(), NOW)).removed).toBe(0);
  });

  test("a tenant that fails is counted and the others still go", async () => {
    const a = await seed("retfail");
    const b = await seed("retok");
    await record(idOf(a), 100);
    await record(idOf(b), 100);
    const report = await enforceRetention(
      {
        ...deps(),
        deleteAuthBefore: async (id, before) => {
          if (id === idOf(a)) throw new Error("boom");
          return authEventsService.deleteBefore(id, before);
        },
      },
      NOW,
    );
    expect(report.failed).toBe(1);
    expect(await authCount(a)).toBe(1);
    expect(await authCount(b)).toBe(0);
  });

  test("deletes more than one batch", async () => {
    const tenant = await seed("retbatch");
    await mongo.db.authEvents.raw.insertMany(
      Array.from({ length: 1_200 }, () => ({
        _id: new ObjectId(),
        tenantId: tenant._id,
        type: "session.signIn",
        at: ago(100),
        outcome: "success",
        reason: null,
        method: null,
        actor: { kind: "user", id: "u" },
        userId: "u",
        clientId: null,
        ip: null,
        userAgent: null,
        requestId: "r",
      })) as never[],
    );
    const report = await enforceRetention(deps(), NOW);
    expect(report.removed).toBe(1_200);
    expect(await authCount(tenant)).toBe(0);
  });
});

describe("a tenant purge", () => {
  test("removes the tenant's sign-in log, leaves its console activity and B's log", async () => {
    const a = await seed("purgea");
    const b = await seed("purgeb");
    await record(idOf(a), 1);
    await record(idOf(b), 1);
    await adminEvent(a._id, 1);
    const trashed = await tenantsService.trash(idOf(a));
    const due = purgeAtOf(trashed.deletedAt as Date);
    expect((await run(due)).purged).toContain(idOf(a));
    expect(await authCount(a)).toBe(0);
    expect(await authCount(b)).toBe(1);
    expect(await adminCount(a._id)).toBe(1);
    // Until its retention ends, the purged tenant's console events are cut by its plan.
    const later = new Date(due.getTime() + 100 * DAY);
    await enforceRetention(deps(), later);
    expect(await adminCount(a._id)).toBe(0);
  });
});
