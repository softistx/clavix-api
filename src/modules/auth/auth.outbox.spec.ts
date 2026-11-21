import { describe, expect, test } from "bun:test";
import { afterAnswer, drain } from "./auth.outbox";

describe("the outbox drain on shutdown", () => {
  test("waits for a mail in flight, then reports drained", async () => {
    let sent = false;
    afterAnswer(
      async () => {
        await Bun.sleep(30);
        sent = true;
      },
      () => {},
    );
    expect(await drain(1_000)).toBe("drained");
    expect(sent).toBe(true);
  });

  test("gives up after the timeout when a mail hangs", async () => {
    let release: () => void = () => {};
    afterAnswer(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      () => {},
    );
    expect(await drain(20)).toBe("timeout");
    release();
    expect(await drain(1_000)).toBe("drained");
  });

  test("is drained at once when nothing is in flight", async () => {
    expect(await drain(1_000)).toBe("drained");
  });
});
