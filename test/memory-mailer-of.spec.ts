import { describe, expect, test } from "bun:test";
import { createMemoryMailer, type Mailer } from "@softistx/mail";
import { memoryMailerOf } from "~/memory-mailer-of";

describe("memoryMailerOf", () => {
  test("returns the memory mailer itself", () => {
    const mailer = createMemoryMailer();
    expect(memoryMailerOf(mailer)).toBe(mailer);
  });

  test("throws on a mailer that is not the memory one", () => {
    const smtp: Mailer = { send: async () => ({ messageId: "x" }) };
    expect(() => memoryMailerOf(smtp)).toThrow(
      "expected the platform mailer to be the memory mailer",
    );
  });
});
