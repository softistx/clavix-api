import { describe, expect, test } from "bun:test";
import { fetchDouble } from "~/fetch-double";

describe("fetchDouble", () => {
  test("answers through the handler", async () => {
    const seen: string[] = [];
    const double = fetchDouble(async (input, init) => {
      seen.push(`${String(input)} ${init?.method ?? "GET"}`);
      return new Response("ok");
    });
    const response = await double("https://x.test/a", { method: "POST" });
    expect(await response.text()).toBe("ok");
    expect(seen).toEqual(["https://x.test/a POST"]);
  });

  test("has the preconnect member of Bun's fetch", () => {
    const double = fetchDouble(async () => new Response());
    expect(double.preconnect).toBeFunction();
    expect(() => double.preconnect("https://x.test")).not.toThrow();
  });
});
