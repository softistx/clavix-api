import { describe, expect, test } from "bun:test";
import { JanusError } from "@softistx/janus";
import { reasonOf, sourceOf } from "./auth.events";

describe("reasonOf", () => {
  test("is janus's code, else the error's own extension code, else `error`", () => {
    const spent = Object.assign(new JanusError("spent"), {
      code: "TOKEN_SPENT",
    });
    expect(reasonOf(spent)).toBe("TOKEN_SPENT");
    expect(reasonOf({ extensions: { code: "CODE_INVALID" } })).toBe(
      "CODE_INVALID",
    );
    expect(reasonOf({ extensions: { code: 4 } })).toBe("error");
    expect(reasonOf(null)).toBe("error");
  });
});

describe("sourceOf", () => {
  const ctxOf = (request: Request) =>
    ({ ip: "198.51.100.9", request }) as never;

  test("names the client, its agent and one request id per request", () => {
    const request = new Request("https://acme.example/graphql", {
      headers: { "user-agent": "Firefox", "x-request-id": "forged" },
    });
    const first = sourceOf(ctxOf(request));
    expect(first.ip).toBe("198.51.100.9");
    expect(first.userAgent).toBe("Firefox");
    expect(first.requestId).not.toBe("forged");
    expect(sourceOf(ctxOf(request)).requestId).toBe(first.requestId);
  });

  test("leaves the agent out when the request has none", () => {
    const request = new Request("https://acme.example/graphql");
    expect(sourceOf(ctxOf(request)).userAgent).toBeUndefined();
  });
});
