import { describe, expect, test } from "bun:test";
import { tenantPurge } from "./tenants.purge-queue";
import { startTenantPurge } from "./tenants.purge-worker";

describe("startTenantPurge", () => {
  test("runs a pass at start, then one per tick; a failed tenant fails the tick", async () => {
    let failed: string[] = ["t1"];
    let runs = 0;
    let tick: (() => Promise<void>) | undefined;
    const queue = {
      work: (handler: () => Promise<void>) => {
        tick = handler;
        return { on: () => {} };
      },
    };
    const logs: string[] = [];
    await startTenantPurge(
      async () => {
        runs += 1;
        return { purged: [], failed };
      },
      queue,
      (message) => logs.push(message),
    );
    expect(runs).toBe(1);
    expect(logs[0]).toContain("purge failed for 1 tenant");
    await expect(tick?.()).rejects.toThrow("purge failed for 1 tenant");
    failed = [];
    await tick?.();
    expect(runs).toBe(3);
  });

  test("with no queue only the start pass runs", async () => {
    let runs = 0;
    await startTenantPurge(async () => {
      runs += 1;
      return { purged: [], failed: [] };
    });
    expect(runs).toBe(1);
  });
});

describe("tenantPurge queue", () => {
  test("ticks daily", () => {
    expect(tenantPurge.name).toBe("tenant-purge");
    expect(tenantPurge.schedules).toMatchObject([
      { id: "daily", kind: "cron", spec: "17 3 * * *" },
    ]);
  });
});
