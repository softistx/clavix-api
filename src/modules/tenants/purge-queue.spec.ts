import { describe, expect, it } from "bun:test";
import { tenantPurge } from "./purge-queue";

describe("tenantPurge queue", () => {
  it("ticks daily at 03:17 UTC and retries a failed pass 3 times with a 5 minute backoff", () => {
    expect(tenantPurge.schedules).toHaveLength(1);
    expect(tenantPurge.schedules[0]).toMatchObject({
      id: "daily",
      kind: "cron",
      spec: "17 3 * * *",
      timezone: "UTC",
    });
    expect(tenantPurge.attempts).toBe(3);
    expect(tenantPurge.backoff.base).toBe(5 * 60_000);
  });
});
