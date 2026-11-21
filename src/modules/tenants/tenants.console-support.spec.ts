import { describe, expect, it } from "bun:test";
import {
  notFound,
  overridesOrFail,
  planOrFail,
  quotasOut,
} from "./tenants.console-support";
import { effectiveQuotas } from "./tenants.plan";

describe("tenants console support", () => {
  it("accepts a known plan and refuses another on `plan`", () => {
    expect(planOrFail("free")).toBe("free");
    expect(() => planOrFail("nope")).toThrow('Unknown plan "nope"');
  });

  it("keeps the overrides that are set and refuses a negative or fractional one", () => {
    expect(overridesOrFail(null)).toEqual({});
    expect(overridesOrFail({ mau: 0, clients: null, domains: 5 })).toEqual({
      mau: 0,
      domains: 5,
    });
    expect(() => overridesOrFail({ mau: -1 })).toThrow("mau must be 0 or more");
    expect(() => overridesOrFail({ clients: 1.5 })).toThrow(
      "clients must be 0 or more",
    );
  });

  it("copies the quotas and words a missing tenant", () => {
    const quotas = effectiveQuotas({
      plan: "free",
      quotaOverrides: { mau: 1 },
    });
    const out = quotasOut(quotas);
    expect(out).toEqual(quotas);
    expect(out).not.toBe(quotas);
    expect(notFound().message).toBe("No such tenant");
  });
});
