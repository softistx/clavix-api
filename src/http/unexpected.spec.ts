import { describe, expect, test } from "bun:test";
import { scrubbed } from "./unexpected";

describe("the logged form of an unexpected error", () => {
  test("keeps name, code and frames, never the message", () => {
    const error = Object.assign(
      new Error('E11000 duplicate key { email: "ada@example.test" }'),
      { code: 11000 },
    );
    const safe = scrubbed(error);
    const logged = JSON.stringify([safe.message, safe.name, safe.stack]);
    expect(logged).not.toContain("ada@example.test");
    expect(logged).not.toContain("E11000");
    expect(safe.message).toContain("11000");
    expect(safe.stack).toContain("unexpected.spec");
  });

  test("a thrown string is not logged", () => {
    expect(scrubbed("token=abc123").message).not.toContain("abc123");
  });
});
