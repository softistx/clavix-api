import { describe, expect, test } from "bun:test";
import {
  AgentsInputError,
  agentsNeedPushOrProof,
  applyAgentsInput,
  MAX_AGENT_LIST,
  sameAgents,
} from "./oauth-policy.rules";
import { type AgentsPolicy, agentsOff } from "./oauth-policy.schema";

const problem = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof AgentsInputError ? error.message : String(error);
  }
  return undefined;
};

describe("applyAgentsInput", () => {
  test("no input keeps the policy, a flag left out keeps its value", () => {
    const current: AgentsPolicy = { ...agentsOff(), dynamic: "open" };
    expect(applyAgentsInput(current, undefined)).toBe(current);
    expect(applyAgentsInput(current, null)).toBe(current);
    expect(applyAgentsInput(current, { metadataDocuments: true })).toEqual({
      ...current,
      metadataDocuments: true,
    });
  });

  test("trims and dedupes the URIs, lower-cases and dedupes the hosts", () => {
    const next = applyAgentsInput(agentsOff(), {
      redirectUris: [" https://app.test/cb ", "https://app.test/cb"],
      allowHosts: ["Docs.Example.com", "docs.example.com"],
    });
    expect(next.redirectUris).toEqual(["https://app.test/cb"]);
    expect(next.allowHosts).toEqual(["docs.example.com"]);
  });

  test("refuses a list past the cap, a bad host and a bad redirect URI", () => {
    const many = Array.from(
      { length: MAX_AGENT_LIST + 1 },
      (_, i) => `h${i}.example.com`,
    );
    expect(
      problem(() => applyAgentsInput(agentsOff(), { allowHosts: many })),
    ).toContain("50 entries at most");
    expect(
      problem(() =>
        applyAgentsInput(agentsOff(), { allowHosts: ["https://x.com/p"] }),
      ),
    ).toContain("must be a DNS name");
    expect(
      problem(() =>
        applyAgentsInput(agentsOff(), { redirectUris: ["not a uri"] }),
      ),
    ).toContain("redirect URI");
    expect(
      problem(() =>
        applyAgentsInput(agentsOff(), {
          redirectUris: [`https://a.test/${"x".repeat(2000)}`],
        }),
      ),
    ).toContain("longer than 2000");
  });
});

describe("sameAgents", () => {
  test("compares the flags and the ordered lists", () => {
    const a: AgentsPolicy = {
      ...agentsOff(),
      allowHosts: ["a.test", "b.test"],
    };
    expect(sameAgents(a, { ...a })).toBe(true);
    expect(sameAgents(a, { ...a, allowHosts: ["b.test", "a.test"] })).toBe(
      false,
    );
    expect(sameAgents(a, { ...a, dynamic: "open" })).toBe(false);
    expect(sameAgents(a, { ...a, metadataDocuments: true })).toBe(false);
  });
});

describe("agentsNeedPushOrProof", () => {
  test("agents on while the tenant must push or prove", () => {
    const on: AgentsPolicy = { ...agentsOff(), dynamic: "restricted" };
    const flags = (par: boolean, dpop: boolean, agents: AgentsPolicy) => ({
      par: { required: par },
      dpop: { required: dpop },
      agents,
    });
    expect(agentsNeedPushOrProof(flags(true, false, on))).toBe(true);
    expect(agentsNeedPushOrProof(flags(false, true, on))).toBe(true);
    expect(agentsNeedPushOrProof(flags(false, false, on))).toBe(false);
    expect(agentsNeedPushOrProof(flags(true, true, agentsOff()))).toBe(false);
    expect(
      agentsNeedPushOrProof(
        flags(true, false, { ...agentsOff(), metadataDocuments: true }),
      ),
    ).toBe(true);
  });
});
