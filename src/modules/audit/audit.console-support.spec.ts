import { describe, expect, it } from "bun:test";
import { InvalidCursorError } from "@softistx/mongo";
import {
  actorOf,
  guarded,
  limitOf,
  resolveEach,
} from "./audit.console-support";

describe("audit console support", () => {
  it("clamps the page size between 1 and 100, 25 by default", () => {
    expect(limitOf(undefined)).toBe(25);
    expect(limitOf(0)).toBe(1);
    expect(limitOf(500)).toBe(100);
  });

  it("looks each distinct id up once", async () => {
    const seen: string[] = [];
    const found = await resolveEach(["a", "b", "a"], async (id) => {
      seen.push(id);
      return id === "a" ? { email: "a@x.y" } : null;
    });
    expect(seen).toEqual(["a", "b"]);
    expect(found.get("a")).toEqual({ email: "a@x.y" });
    expect(found.get("b")).toBeNull();
  });

  it("names only user actors", () => {
    const people = new Map([["u", { name: "Ann", email: "a@x.y" }]]);
    expect(actorOf("user", "u", people)).toEqual({
      kind: "user",
      id: "u",
      name: "Ann",
      email: "a@x.y",
    });
    expect(actorOf("client", "u", people).name).toBeNull();
  });

  it("turns a refused cursor into the caller's mistake and rethrows the rest", async () => {
    await expect(
      guarded(async () => {
        throw new InvalidCursorError("bad");
      }),
    ).rejects.toThrow("The cursor is not valid");
    await expect(
      guarded(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await guarded(async () => 1)).toBe(1);
  });
});
