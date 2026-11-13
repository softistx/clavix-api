import { describe, expect, test } from "bun:test";
import { tlsAskGate } from "./tls-limit";

describe("tlsAskGate", () => {
  test("follows the limiter while Redis answers", async () => {
    const warnings: string[] = [];
    const log = (m: string) => warnings.push(m);
    expect(await tlsAskGate(async () => ({ allowed: true }), log)()).toBe(true);
    expect(await tlsAskGate(async () => ({ allowed: false }), log)()).toBe(
      false,
    );
    expect(warnings).toEqual([]);
  });

  test("fails closed and warns when Redis is down", async () => {
    const warnings: string[] = [];
    const gate = tlsAskGate(
      async () => {
        throw new Error("ECONNREFUSED");
      },
      (m) => warnings.push(m),
    );
    expect(await gate()).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tls ask");
  });
});
