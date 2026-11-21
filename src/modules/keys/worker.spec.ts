import { describe, expect, test } from "bun:test";
import { keyRotation } from "./queue";
import { startKeyRotation } from "./worker";

describe("startKeyRotation", () => {
  test("runs a pass at start, then one per tick on the queue", async () => {
    const passes: string[] = [];
    let tick: (() => Promise<void>) | undefined;
    const queue = {
      work: (handler: () => Promise<void>) => {
        tick = handler;
        return { on: () => {} };
      },
    };
    const deps = {
      signingKeysFor: () => {
        passes.push("rotate");
        throw new Error("down");
      },
      activeTenantIds: async () => ["x"],
      log: () => {},
    };
    await startKeyRotation(deps, queue);
    expect(passes).toEqual(["rotate"]); // the start pass, its failure logged not thrown
    await expect(tick?.()).rejects.toThrow("rotation failed for 1 tenant");
    expect(passes).toHaveLength(2);
  });

  test("with no queue only the start pass runs", async () => {
    let n = 0;
    await startKeyRotation({
      signingKeysFor: () => {
        n += 1;
        throw new Error("x");
      },
      activeTenantIds: async () => ["x"],
      log: () => {},
    });
    expect(n).toBe(1);
  });
});

describe("keyRotation queue", () => {
  test("ticks hourly", () => {
    expect(keyRotation.name).toBe("key-rotation");
    expect(keyRotation.schedules).toMatchObject([
      { id: "hourly", kind: "cron", spec: "0 * * * *" },
    ]);
  });
});
