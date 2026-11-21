import { afterAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authEventsService as service } from "@/config/audit";
import { mongo } from "@/config/db";
import { RETENTION_BATCH } from "./audit.utils";

// Tenant ids of their own: the service reads and writes through the scope.
const tenant = new ObjectId().toHexString();
const other = new ObjectId().toHexString();
const DAY = 86_400_000;
const NOW = Date.now();

const record = (tenantId: string, days: number, userId = "u1") =>
  service.record({
    kind: "auth",
    tenantId,
    type: "session.signIn",
    outcome: "success",
    userId,
    at: new Date(NOW - days * DAY),
  });

afterAll(async () => {
  for (const id of [tenant, other]) {
    await mongo.db.authEvents.raw.deleteMany({ tenantId: new ObjectId(id) });
  }
});

describe("AuditService", () => {
  test("pages newest first with a total, within the tenant", async () => {
    for (const days of [3, 2, 1]) await record(tenant, days);
    await record(other, 1);
    const first = await service.page(tenant, {}, { after: null, limit: 2 });
    expect(first.totalCount).toBe(3);
    expect(first.items.map((e) => e.at.getTime())).toEqual([
      NOW - DAY,
      NOW - 2 * DAY,
    ]);
    const second = await service.page(
      tenant,
      {},
      { after: first.nextCursor, limit: 2 },
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  test("find is the tenant's own, null for a bad or foreign id", async () => {
    const [event] = (await service.page(tenant, {}, { after: null, limit: 1 }))
      .items;
    const id = String(event?._id);
    expect((await service.find(tenant, id))?._id.toHexString()).toBe(id);
    expect(await service.find(other, id)).toBeNull();
    expect(await service.find(tenant, "nope")).toBeNull();
  });

  test("exceeds and stream follow the filter", async () => {
    expect(await service.exceeds(tenant, {}, 2)).toBe(true);
    expect(await service.exceeds(tenant, {}, 3)).toBe(false);
    const streamed: Date[] = [];
    for await (const e of service.stream(tenant, { userId: "u1" }, 2)) {
      streamed.push(e.at);
    }
    expect(streamed).toHaveLength(2);
  });

  test("deleteBefore removes the older events, batch after batch", async () => {
    expect(RETENTION_BATCH).toBeGreaterThan(0);
    const removed = await service.deleteBefore(
      tenant,
      new Date(NOW - 1.5 * DAY),
    );
    expect(removed).toBe(2);
    expect(
      (await service.page(tenant, {}, { after: null, limit: 9 })).totalCount,
    ).toBe(1);
    expect(
      (await service.page(other, {}, { after: null, limit: 9 })).totalCount,
    ).toBe(1);
  });
});
