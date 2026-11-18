import { describe, expect, test } from "bun:test";
import { createEventBus } from "./bus";
import type { AuthEvent } from "./types";

const event: AuthEvent = {
  kind: "auth",
  tenantId: "a".repeat(24),
  type: "session.signIn",
  outcome: "success",
};

describe("the event bus", () => {
  test("every subscriber gets the event, awaited", async () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.subscribe(async () => {
      await Promise.resolve();
      seen.push("one");
    });
    bus.subscribe(() => {
      seen.push("two");
    });
    await bus.emit(event);
    expect(seen.sort()).toEqual(["one", "two"]);
  });

  test("a failing subscriber is reported, never raised, and the others still run", async () => {
    const failures: unknown[] = [];
    const bus = createEventBus({ onFailure: (error) => failures.push(error) });
    let reached = false;
    bus.subscribe(() => {
      throw new Error("store down");
    });
    bus.subscribe(() => {
      reached = true;
    });
    await expect(bus.emit(event)).resolves.toBeUndefined();
    expect(reached).toBe(true);
    expect(failures).toHaveLength(1);
  });

  test("a failing failure hook does not fail the emitter either", async () => {
    const bus = createEventBus({
      onFailure: () => {
        throw new Error("hook");
      },
    });
    bus.subscribe(() => {
      throw new Error("store down");
    });
    await expect(bus.emit(event)).resolves.toBeUndefined();
  });

  test("an unsubscribed subscriber is not called", async () => {
    const bus = createEventBus();
    let calls = 0;
    const off = bus.subscribe(() => {
      calls += 1;
    });
    off();
    await bus.emit(event);
    expect(calls).toBe(0);
  });
});
