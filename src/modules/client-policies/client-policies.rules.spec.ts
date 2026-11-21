import { describe, expect, test } from "bun:test";
import { CatalogError } from "@/modules/resources";
import { validateTokenExchange } from "./client-policies.rules";

const uris: string[] = ["https://api.test/a", "https://api.test/b"];

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof CatalogError
      ? `${error.code}: ${error.message}`
      : String(error);
  }
  return undefined;
};

describe("validateTokenExchange", () => {
  test("dedupes the targets and the subject clients", () => {
    expect(
      validateTokenExchange(
        {
          targetResources: ["https://api.test/a", "https://api.test/a"],
          subjectClients: ["a-1", "a-1", "b"],
        },
        uris,
      ),
    ).toEqual({
      targets: ["https://api.test/a"],
      subjects: ["a-1", "b"],
      agents: false,
    });
  });

  test("keeps 'any' and reads the agents switch", () => {
    expect(
      validateTokenExchange(
        { targetResources: [], subjectClients: "any", subjectAgents: true },
        uris,
      ),
    ).toEqual({ targets: [], subjects: "any", agents: true });
  });

  test("refuses a target that is not a resource of the tenant", () => {
    expect(
      refusal(() =>
        validateTokenExchange(
          { targetResources: ["https://x.test"], subjectClients: [] },
          uris,
        ),
      ),
    ).toBe('BAD_USER_INPUT: "https://x.test" is not a resource of this tenant');
  });

  test("caps the targets at 20 and the subject clients at 50", () => {
    const many = Array.from({ length: 21 }, (_, i) => `u${i}`);
    expect(
      refusal(() =>
        validateTokenExchange(
          { targetResources: many, subjectClients: [] },
          many,
        ),
      ),
    ).toContain("at most 20 resources");
    const clients = Array.from({ length: 51 }, (_, i) => `c${i}`);
    expect(
      refusal(() =>
        validateTokenExchange(
          { targetResources: [], subjectClients: clients },
          uris,
        ),
      ),
    ).toContain("at most 50 clients");
  });

  test("accepts exactly the limits", () => {
    const many = Array.from({ length: 20 }, (_, i) => `u${i}`);
    const clients = Array.from({ length: 50 }, (_, i) => `c${i}`);
    expect(
      refusal(() =>
        validateTokenExchange(
          { targetResources: many, subjectClients: clients },
          many,
        ),
      ),
    ).toBeUndefined();
  });

  test("refuses a subject client id of the wrong shape", () => {
    for (const bad of ["Upper", "a b", "", "x".repeat(65)]) {
      expect(
        refusal(() =>
          validateTokenExchange(
            { targetResources: [], subjectClients: [bad] },
            uris,
          ),
        ),
      ).toContain("is not a client id");
    }
  });
});
