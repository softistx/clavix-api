import { describe, expect, test } from "bun:test";
import type { AuthEvent } from "@/events/types";
import { drain, EXPORT_BATCH, filterOf, storedEvent } from "./audit.utils";

const base: AuthEvent = {
  kind: "auth",
  tenantId: "t",
  type: "session.signIn",
  outcome: "success",
};
const NOW = new Date("2026-11-18T12:00:00Z");

describe("filterOf", () => {
  test("an empty filter matches everything", () => {
    expect(filterOf({})).toEqual({});
    expect(filterOf({ types: [], userId: null })).toEqual({});
    expect(
      filterOf({
        from: null,
        to: null,
        types: null,
        clientId: null,
        outcome: null,
      }),
    ).toEqual({});
  });

  test("combines the set fields", () => {
    const from = new Date("2026-01-01");
    const to = new Date("2026-02-01");
    expect(
      filterOf({
        from,
        to,
        types: ["session.signIn"],
        userId: "u",
        clientId: "c",
        outcome: "failure",
      }),
    ).toEqual({
      at: { $gte: from, $lte: to },
      type: { $in: ["session.signIn"] },
      userId: "u",
      clientId: "c",
      outcome: "failure",
    });
    expect(filterOf({ to })).toEqual({ at: { $lte: to } });
  });
});

describe("storedEvent", () => {
  test("a user event stores the fields it names, nulls for the rest", () => {
    const stored = storedEvent({ ...base, userId: "u1", ip: "1.2.3.4" }, NOW);
    expect(stored).toMatchObject({
      at: NOW,
      actor: { kind: "user", id: "u1" },
      userId: "u1",
      clientId: null,
      reason: null,
      method: null,
      ip: "1.2.3.4",
    });
    expect(stored.requestId.length).toBeGreaterThan(0);
  });

  test("an event with a client and no user is the client's", () => {
    expect(storedEvent({ ...base, clientId: "c1" }, NOW).actor).toEqual({
      kind: "client",
      id: "c1",
    });
  });

  test("an anonymous failure is the anonymous user, and an extra field is not stored", () => {
    const stored = storedEvent(
      { ...base, outcome: "failure", at: new Date(0), requestId: "r" },
      NOW,
    );
    expect(stored.actor).toEqual({ kind: "user", id: "anonymous" });
    expect(stored.at).toEqual(new Date(0));
    expect(stored.requestId).toBe("r");
    expect(Object.keys(stored)).not.toContain("kind");
  });
});

describe("drain", () => {
  const pager = (total: number) => {
    const sizes: number[] = [];
    const read = async (after: string | null, size: number) => {
      sizes.push(size);
      const start = after === null ? 0 : Number(after);
      const items = Array.from(
        { length: Math.max(0, Math.min(size, total - start)) },
        (_, i) => start + i,
      );
      const next = start + items.length;
      return { items, nextCursor: next < total ? String(next) : null };
    };
    return { read, sizes };
  };

  test("walks the pages to the end", async () => {
    const { read, sizes } = pager(EXPORT_BATCH + 10);
    const seen: number[] = [];
    for await (const item of drain(read, 10_000)) seen.push(item);
    expect(seen).toHaveLength(EXPORT_BATCH + 10);
    expect(sizes[0]).toBe(EXPORT_BATCH);
  });

  test("stops at the limit, asking no more than what is left", async () => {
    const { read, sizes } = pager(100);
    const seen: number[] = [];
    for await (const item of drain(read, 7)) seen.push(item);
    expect(seen).toHaveLength(7);
    expect(sizes).toEqual([7]);
  });
});
