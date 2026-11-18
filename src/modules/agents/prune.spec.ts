import { describe, expect, test } from "bun:test";
import { AGENT_GRACE_DAYS, type PruneDeps, pruneAgents } from "./prune";
import { agentPruneEventInput, PRUNE_ACTOR } from "./prune-events";
import { startAgentsPrune } from "./prune-worker";

const NOW = new Date("2026-11-17T12:00:00Z");
const DAY = 86_400_000;

function deps(over: Partial<PruneDeps> = {}) {
  const state = {
    asked: [] as Date[],
    removed: [] as string[],
    events: [] as string[],
    logs: [] as string[],
  };
  const full: PruneDeps = {
    tenantIds: async () => ["t1"],
    candidates: async (_t, before) => {
      state.asked.push(before);
      return ["a", "b"];
    },
    hasStandingGrant: async () => false,
    remove: async (t, c) => void state.removed.push(`${t}/${c}`),
    emit: async (e) => void state.events.push(`${e.tenantId}/${e.clientId}`),
    log: (m) => state.logs.push(m),
    ...over,
  };
  return { full, state };
}

describe("pruneAgents", () => {
  test("asks for agents registered before now minus 7 days", async () => {
    const { full, state } = deps();
    await pruneAgents(full, NOW);
    expect(AGENT_GRACE_DAYS).toBe(7);
    expect(state.asked[0]?.getTime()).toBe(NOW.getTime() - 7 * DAY);
  });

  test("deletes the agents with no standing grant and records one event each", async () => {
    const { full, state } = deps();
    expect(await pruneAgents(full, NOW)).toEqual({ pruned: 2, failed: 0 });
    expect(state.removed).toEqual(["t1/a", "t1/b"]);
    expect(state.events).toEqual(["t1/a", "t1/b"]);
  });

  test("keeps an agent that has a standing grant", async () => {
    const { full, state } = deps({
      hasStandingGrant: async (_t, c) => c === "a",
    });
    expect(await pruneAgents(full, NOW)).toEqual({ pruned: 1, failed: 0 });
    expect(state.removed).toEqual(["t1/b"]);
  });

  test("a failing agent is counted and the others go on", async () => {
    const { full, state } = deps({
      remove: async (_t, c) => {
        if (c === "a") throw new Error("boom");
        state.removed.push(c);
      },
    });
    expect(await pruneAgents(full, NOW)).toEqual({ pruned: 1, failed: 1 });
    expect(state.removed).toEqual(["b"]);
    expect(state.events).toEqual(["t1/b"]);
    expect(state.logs[0]).toContain("could not prune a");
  });

  test("a failing tenant listing does not stop the other tenants", async () => {
    const { full, state } = deps({
      tenantIds: async () => ["bad", "t2"],
      candidates: async (t) => {
        if (t === "bad") throw new Error("nope");
        return ["x"];
      },
    });
    expect(await pruneAgents(full, NOW)).toEqual({ pruned: 1, failed: 1 });
    expect(state.removed).toEqual(["t2/x"]);
  });

  test("a failed admin event is logged and does not undo the deletion", async () => {
    const { full, state } = deps({
      emit: async () => {
        throw new Error("no event");
      },
    });
    expect(await pruneAgents(full, NOW)).toEqual({ pruned: 2, failed: 0 });
    expect(state.logs).toHaveLength(2);
  });
});

describe("agentPruneEventInput", () => {
  test("is a system actor with identifiers only", () => {
    const input = agentPruneEventInput({
      tenantId: "t1",
      clientId: "x".repeat(300),
    });
    expect(PRUNE_ACTOR).toBe("system:agents:prune");
    expect(input).toMatchObject({
      actor: "system:agents:prune",
      action: "agent.prune",
      tenantId: "t1",
    });
    expect(input.target.id).toHaveLength(200);
    expect(input.requestId).toBeString();
  });
});

describe("startAgentsPrune", () => {
  const queueOf = () => {
    let handler: (() => Promise<void>) | undefined;
    const errors: ((e: unknown) => void)[] = [];
    return {
      queue: {
        work(h: () => Promise<void>) {
          handler = h;
          return {
            on(_: "error", fn: (e: unknown) => void) {
              errors.push(fn);
            },
          };
        },
      },
      tick: () => handler?.(),
      errors,
    };
  };

  test("does nothing without a queue and runs nothing at start", () => {
    let runs = 0;
    const countRun = async () => {
      runs += 1;
      return { pruned: 0, failed: 0 };
    };
    startAgentsPrune(countRun);
    const q = queueOf();
    startAgentsPrune(countRun, q.queue);
    expect(runs).toBe(0);
  });

  test("a tick runs the pass; unfinished agents make it throw so the queue retries", async () => {
    const q = queueOf();
    let report = { pruned: 1, failed: 0 };
    startAgentsPrune(async () => report, q.queue);
    await q.tick();
    report = { pruned: 0, failed: 2 };
    await expect(q.tick()).rejects.toThrow("2 agent(s) unfinished");
  });
});
