import { describe, expect, test } from "bun:test";
import type { ExchangeRules } from "./ports";
import { exchangePolicy } from "./token-exchange";

const TARGET = "https://target.example/api";
const call = (
  rules: ExchangeRules | null | undefined,
  over: { resource?: string; subjectClient?: string } = {},
) => {
  const asked: string[] = [];
  const policy = exchangePolicy(
    rules === undefined
      ? undefined
      : async (clientId) => {
          asked.push(clientId);
          return rules;
        },
  );
  const answer = policy({
    clientId: "exch",
    subject: {
      userId: "u",
      clientId: over.subjectClient ?? "web",
      scopes: ["read"],
      resource: "https://source.example/api",
      authorizationDetails: [],
    },
    actor: null,
    scopes: ["read"],
    resource: over.resource ?? TARGET,
    authorizationDetails: [],
  });
  return { answer, asked };
};

describe("exchangePolicy", () => {
  test("delegation for a listed target and subject client", async () => {
    const { answer, asked } = call({
      targetResources: [TARGET],
      subjectClients: ["web"],
    });
    expect(await answer).toEqual({ mode: "delegation" });
    expect(asked).toEqual(["exch"]);
  });

  test("any subject client is allowed by `any`", async () => {
    const { answer } = call(
      { targetResources: [TARGET], subjectClients: "any" },
      { subjectClient: "whatever" },
    );
    expect(await answer).toEqual({ mode: "delegation" });
  });

  test("no port, or no rules, is refused", async () => {
    expect(await call(undefined).answer).toBeNull();
    expect(await call(null).answer).toBeNull();
  });

  test("a target the rules do not list is refused", async () => {
    const { answer } = call(
      { targetResources: [TARGET], subjectClients: "any" },
      { resource: "https://other.example/api" },
    );
    expect(await answer).toBeNull();
  });

  test("a subject client the rules do not list is refused", async () => {
    const { answer } = call(
      { targetResources: [TARGET], subjectClients: ["web"] },
      { subjectClient: "mobile" },
    );
    expect(await answer).toBeNull();
  });
});
