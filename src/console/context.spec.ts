import { describe, expect, test } from "bun:test";
import { consoleContextOf, isConsoleContext } from "./context";

const functions = {
  can: async () => true,
  canPlatform: async () => true,
  audit: async () => undefined,
};
const services = {
  principal: {},
  access: {},
  directory: {},
  admins: {},
  members: {},
  users: {},
  exclusive: async () => undefined,
  budgets: {},
  activity: {},
};
const complete = {
  request: new Request("https://console.clavix.test/api"),
  ...functions,
  ...services,
};

describe("isConsoleContext", () => {
  test("accepts what the console plugin puts on a context", () => {
    expect(isConsoleContext(complete)).toBe(true);
  });

  test("refuses anything missing a part of it", () => {
    expect(isConsoleContext(null)).toBe(false);
    expect(isConsoleContext("ctx")).toBe(false);
    expect(isConsoleContext({ ...complete, request: undefined })).toBe(false);
    expect(isConsoleContext({ ...complete, can: undefined })).toBe(false);
    expect(isConsoleContext({ ...complete, budgets: undefined })).toBe(false);
  });
});

describe("consoleContextOf", () => {
  test("gives the context back", () => {
    expect(Object.is(consoleContextOf(complete), complete)).toBe(true);
  });

  test("throws a plain error, a masked 500, for another context", () => {
    let thrown: unknown;
    try {
      consoleContextOf({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toHaveProperty("extensions");
  });
});
