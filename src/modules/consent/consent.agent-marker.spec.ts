import { describe, expect, test } from "bun:test";
import { agentMarksReader, markOf } from "./consent.agent-marker";

describe("markOf", () => {
  test("marks a client the tenant registered as an agent, with its time", () => {
    const at = new Date(Date.UTC(2026, 0, 2));
    expect(markOf(new Map([["c1", at]]), "c1")).toEqual({
      agent: true,
      registeredAt: at.toISOString(),
    });
  });
  test("leaves any other client, or no marks, unmarked", () => {
    const none = { agent: false, registeredAt: null };
    expect(markOf(new Map(), "c1")).toEqual(none);
    expect(markOf(undefined, "c1")).toEqual(none);
  });
});

describe("agentMarksReader", () => {
  test("reads once per request and client, and nothing without both", async () => {
    let reads = 0;
    const agents = async () => {
      reads += 1;
      return new Map<string, Date>();
    };
    const read = agentMarksReader();
    const request = new Request("https://a.test/");
    await read(request, agents, "c1");
    await read(request, agents, "c1");
    await read(request, agents, "c2");
    expect(reads).toBe(2);
    expect(read(undefined, agents, "c1")).toBeUndefined();
  });
});
