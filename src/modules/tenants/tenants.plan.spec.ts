import { expect, test } from "bun:test";
import { isPlanId, PLAN_IDS, planOf } from "./tenants.plan";

test("planOf answers the plan of every plan id", () => {
  for (const id of PLAN_IDS) expect(planOf(id).id).toBe(id);
});

test("isPlanId accepts the plan ids only", () => {
  expect(isPlanId("pro")).toBe(true);
  expect(isPlanId("gold")).toBe(false);
});
