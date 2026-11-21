import { describe, expect, it } from "bun:test";
import { InvalidSlugError, SlugTakenError } from "@/modules/tenants";
import { badInput, refusal } from "./tenants.console-errors";

describe("tenants console errors", () => {
  it("words a malformed input with its field", () => {
    const error = badInput("bad", "name");
    expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
  });

  it("maps the service's refusals and passes anything else through", () => {
    const taken = refusal(new SlugTakenError("acme")) as {
      extensions: Record<string, unknown>;
    };
    expect(taken.extensions["code"]).toBe("SLUG_TAKEN");
    const invalid = refusal(new InvalidSlugError("x")) as {
      extensions: Record<string, unknown>;
    };
    expect(invalid.extensions["code"]).toBe("BAD_USER_INPUT");
    const other = new Error("boom");
    expect(refusal(other)).toBe(other);
  });
});
