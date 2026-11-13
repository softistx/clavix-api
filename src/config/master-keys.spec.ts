import { expect, test } from "bun:test";
import { masterKeysProblem, parseMasterKeys } from "./master-keys";

const a = Buffer.alloc(32, 1).toString("base64");
const b = Buffer.alloc(32, 2).toString("base64");

test("a single key keeps working", () => {
  expect(masterKeysProblem(a)).toBeUndefined();
  const keys = parseMasterKeys(a);
  expect(keys).toHaveLength(1);
  expect(Buffer.from(keys[0] as Uint8Array)).toEqual(Buffer.alloc(32, 1));
});

test("a comma-separated list is a keyring, the first key being the current one", () => {
  expect(masterKeysProblem(`${b},${a}`)).toBeUndefined();
  const keys = parseMasterKeys(` ${b} , ${a} `);
  expect(keys.map((key) => Buffer.from(key)[0])).toEqual([2, 1]);
});

test("a malformed, short, empty or repeated key is refused", () => {
  for (const bad of [
    "",
    ",",
    `${a},`,
    `${a},${Buffer.alloc(16, 3).toString("base64")}`,
    `${a},not base64 at all, but 44 characters long......`,
  ]) {
    expect(masterKeysProblem(bad)).toContain("32 bytes");
  }
  expect(masterKeysProblem(`${a},${b},${a}`)).toContain("twice");
  expect(() => parseMasterKeys(`${a},${a}`)).toThrow("CLAVIX_KEYS_MASTER_KEY");
});
