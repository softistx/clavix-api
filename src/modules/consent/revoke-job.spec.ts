import { describe, expect, test } from "bun:test";
import { createGrantsRevoke } from "@/config/grants-revoke";
import type { Context } from "@/http/context";
import { grantsRevoke } from "./revoke.queue";
import { revokeOnReplace, startGrantsRevoke } from "./revoke-job";

const ctx = {} as Context;
const quiet = () => {};

describe("revokeOnReplace", () => {
  test("revokes inline and queues nothing when it works", async () => {
    const jobs: unknown[] = [];
    await revokeOnReplace(
      ctx,
      "t1",
      "u1",
      { add: async (d) => jobs.push(d) },
      async () => 2,
      quiet,
    );
    expect(jobs).toEqual([]);
  });

  test("queues the revocation when the inline one fails", async () => {
    const jobs: unknown[] = [];
    await revokeOnReplace(
      ctx,
      "t1",
      "u1",
      { add: async (d) => jobs.push(d) },
      async () => {
        throw new Error("down");
      },
      quiet,
    );
    expect(jobs).toEqual([{ tenantId: "t1", userId: "u1" }]);
  });

  test("rethrows the failure with no queue or when the queue refuses", async () => {
    const down = async () => {
      throw new Error("down");
    };
    await expect(
      revokeOnReplace(ctx, "t", "u", undefined, down, quiet),
    ).rejects.toThrow("down");
    await expect(
      revokeOnReplace(
        ctx,
        "t",
        "u",
        {
          add: async () => {
            throw new Error("redis");
          },
        },
        down,
        quiet,
      ),
    ).rejects.toThrow("down");
  });
});

describe("startGrantsRevoke", () => {
  test("a failed run throws so the queue retries; a later run succeeds", async () => {
    let handler:
      | ((job: {
          data: { tenantId: string; userId: string };
        }) => Promise<unknown>)
      | undefined;
    let calls = 0;
    startGrantsRevoke(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("down");
        return 1;
      },
      {
        work: (fn) => {
          handler = fn;
          return { on: () => {} };
        },
      },
      quiet,
    );
    const job = { data: { tenantId: "t", userId: "u" } };
    await expect(handler?.(job)).rejects.toThrow("down");
    await handler?.(job);
    expect(calls).toBe(2);
  });

  test("the queue retries 8 times with a 1 minute backoff capped at an hour", () => {
    expect(grantsRevoke.attempts).toBe(8);
    expect(grantsRevoke.backoff.base).toBe(60_000);
    expect(grantsRevoke.backoff.max).toBe(3_600_000);
  });
});

describe("createGrantsRevoke", () => {
  const job = { tenantId: "t", userId: "u" };
  test("a tenant that is gone has nothing to revoke", async () => {
    const run = createGrantsRevoke(
      async () => {
        throw new Error("unused");
      },
      async () => undefined,
    );
    expect(await run(job)).toBe(0);
  });

  test("a purged tenant (no server) is done: the job is dropped, not retried", async () => {
    const run = createGrantsRevoke(
      async () => null,
      async () => "acme",
    );
    expect(await run(job)).toBe(0);
  });

  test("revokes through the tenant's server", async () => {
    const seen: unknown[] = [];
    const server = {
      grants: {
        revokeAll: async (who: unknown) => {
          seen.push(who);
          return 3;
        },
      },
    };
    const run = createGrantsRevoke(
      (async () => server) as never,
      async () => "acme",
    );
    expect(await run(job)).toBe(3);
    expect(seen).toEqual([{ id: "u" }]);
  });
});
