import { describe, expect, test } from "bun:test";
import { createExclusive } from "./exclusive";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe("createExclusive", () => {
  test("one at a time per key, other keys beside it, a failure frees the key", async () => {
    const exclusive = createExclusive();
    const log: string[] = [];
    const work =
      (name: string, fail = false) =>
      async () => {
        log.push(`${name}+`);
        await tick();
        log.push(`${name}-`);
        if (fail) throw new Error(name);
        return name;
      };
    const results = await Promise.allSettled([
      exclusive("k", work("1", true)),
      exclusive("k", work("2")),
      exclusive("other", work("3")),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(log.filter((entry) => entry !== "3+" && entry !== "3-")).toEqual([
      "1+",
      "1-",
      "2+",
      "2-",
    ]);
    expect(log.indexOf("3+")).toBeLessThan(log.indexOf("2+"));
  });

  test("a shared lock wraps the work, under its own key", async () => {
    const keys: string[] = [];
    const exclusive = createExclusive(async (key, work) => {
      keys.push(key);
      return work();
    });
    expect(await exclusive("console:members:t", async () => 1)).toBe(1);
    expect(keys).toEqual(["exclusive:console:members:t"]);
  });
});
