import { describe, expect, spyOn, test } from "bun:test";
import { createGrantsRevoke } from "@/config/grants-revoke";
import type { Context } from "@/http/context";
import { grantsRevoke } from "./consent.queue";
import { ConsentService } from "./consent.service";

const ctx = {} as Context;
const quiet = () => {};
const down = async (): Promise<number> => {
  throw new Error("down");
};

// A service whose inline revocation is `revoke`, and whose log is silent.
const serviceRevoking = (revoke: () => Promise<number>) => {
  const service = new ConsentService({ log: quiet });
  spyOn(service, "revokeGrants").mockImplementation(revoke);
  return service;
};

describe("revokeOnReplace", () => {
  test("revokes inline and queues nothing when it works", async () => {
    const jobs: unknown[] = [];
    await serviceRevoking(async () => 2).revokeOnReplace(ctx, "t1", "u1", {
      add: async (d) => jobs.push(d),
    });
    expect(jobs).toEqual([]);
  });

  test("queues the revocation when the inline one fails", async () => {
    const jobs: unknown[] = [];
    await serviceRevoking(down).revokeOnReplace(ctx, "t1", "u1", {
      add: async (d) => jobs.push(d),
    });
    expect(jobs).toEqual([{ tenantId: "t1", userId: "u1" }]);
  });

  test("rethrows the failure with no queue or when the queue refuses", async () => {
    const service = serviceRevoking(down);
    await expect(
      service.revokeOnReplace(ctx, "t", "u", undefined),
    ).rejects.toThrow("down");
    await expect(
      service.revokeOnReplace(ctx, "t", "u", {
        add: async () => {
          throw new Error("redis");
        },
      }),
    ).rejects.toThrow("down");
  });
});

describe("startRevokeWorker", () => {
  test("a failed run throws so the queue retries; a later run succeeds", async () => {
    let handler:
      | ((job: {
          data: { tenantId: string; userId: string };
        }) => Promise<unknown>)
      | undefined;
    let calls = 0;
    new ConsentService({ log: quiet }).startRevokeWorker(
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
