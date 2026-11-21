import { describe, expect, test } from "bun:test";
import type { ExchangeRules } from "./ports";
import { exchangePolicy } from "./token-exchange";

const TARGET = "https://target.example/api";
const call = (
  rules: ExchangeRules | null,
  over: {
    resource?: string;
    subjectClient?: string;
    agents?: readonly string[];
    details?: readonly { type: string }[];
  } = {},
) => {
  const asked: string[] = [];
  const policy = exchangePolicy(
    async (clientId) => {
      asked.push(clientId);
      return rules;
    },
    async (clientId) => over.agents?.includes(clientId) === true,
  );
  const answer = policy({
    clientId: "exch",
    subject: {
      userId: "u",
      clientId: over.subjectClient ?? "web",
      scopes: ["read"],
      resource: "https://source.example/api",
      authorizationDetails: over.details ?? [],
    },
    actor: null,
    scopes: ["read"],
    resource: over.resource ?? TARGET,
    authorizationDetails: over.details ?? [],
  });
  return { answer, asked };
};

describe("exchangePolicy", () => {
  test("delegation for a listed target and subject client", async () => {
    const { answer, asked } = call({
      targetResources: [TARGET],
      subjectClients: ["web"],
      subjectAgents: false,
    });
    expect(await answer).toEqual({ mode: "delegation" });
    expect(asked).toEqual(["exch"]);
  });

  test("any subject client is allowed by `any`", async () => {
    const { answer } = call(
      {
        targetResources: [TARGET],
        subjectClients: "any",
        subjectAgents: false,
      },
      { subjectClient: "whatever" },
    );
    expect(await answer).toEqual({ mode: "delegation" });
  });

  test("a client with no rules is refused", async () => {
    expect(await call(null).answer).toBeNull();
  });

  test("a target the rules do not list is refused", async () => {
    const { answer } = call(
      {
        targetResources: [TARGET],
        subjectClients: "any",
        subjectAgents: false,
      },
      { resource: "https://other.example/api" },
    );
    expect(await answer).toBeNull();
  });

  test("a subject client the rules do not list is refused", async () => {
    const { answer } = call(
      {
        targetResources: [TARGET],
        subjectClients: ["web"],
        subjectAgents: false,
      },
      { subjectClient: "mobile" },
    );
    expect(await answer).toBeNull();
  });

  describe("subjectAgents (D12)", () => {
    const rules = (subjectAgents: boolean): ExchangeRules => ({
      targetResources: [TARGET],
      subjectClients: [],
      subjectAgents,
    });

    test("an agent's token is exchanged, in delegation", async () => {
      const { answer } = call(rules(true), {
        subjectClient: "agent-1",
        agents: ["agent-1"],
      });
      expect(await answer).toEqual({ mode: "delegation" });
    });

    test("the switch off refuses an agent's token", async () => {
      const { answer } = call(rules(false), {
        subjectClient: "agent-1",
        agents: ["agent-1"],
      });
      expect(await answer).toBeNull();
    });

    test("a client that is no agent is not covered", async () => {
      const { answer } = call(rules(true), {
        subjectClient: "web",
        agents: ["agent-1"],
      });
      expect(await answer).toBeNull();
    });

    test("a listed client still passes with the switch on", async () => {
      const { answer } = call(
        { ...rules(true), subjectClients: ["web"] },
        { subjectClient: "web" },
      );
      expect(await answer).toEqual({ mode: "delegation" });
    });

    test("the policy leaves the details alone, so janus inherits them on the same resource", async () => {
      const { answer } = call(rules(true), {
        subjectClient: "agent-1",
        agents: ["agent-1"],
        details: [{ type: "payment" }],
      });
      expect(await answer).toEqual({ mode: "delegation" });
    });
  });
});
