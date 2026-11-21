import { expect, test } from "bun:test";
import { common, errorCodes, groups } from "./codes";

test("every code is declared once, by one module", () => {
  const seen = new Map<string, string>();
  for (const { module, codes } of groups) {
    for (const code of codes) {
      expect(seen.get(code), `${code} in ${module}`).toBeUndefined();
      seen.set(code, module);
    }
  }
  expect(errorCodes.length).toBe(seen.size);
});

test("a code is UPPER_SNAKE, the contract of the UI and the SDK", () => {
  for (const code of errorCodes) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
});

test("the answers every module gives alike are declared in common", () => {
  expect(common.codes).toEqual([
    "BAD_USER_INPUT",
    "NOT_FOUND",
    "CONFLICT",
    "RATE_LIMITED",
    "SERVICE_UNAVAILABLE",
  ]);
});

test("every module is listed with a distinct name", () => {
  const names = groups.map((group) => group.module);
  expect(new Set(names).size).toBe(names.length);
});
