import { describe, expect, test } from "bun:test";
import { resourceUriProblem } from "./resource-uri";

describe("resourceUriProblem loopback hosts", () => {
  test.each([
    "http://localhost:5299/api",
    "http://127.0.0.1:5299/api",
    "http://[::1]:5299/api",
    "http://console.clavix.localhost:5299/api",
    "http://clavix.localhost/api",
    "http://LOCALHOST./api",
  ])("allows http on %s", (uri) => {
    expect(resourceUriProblem(uri)).toBeNull();
  });

  test.each([
    "http://example.com/api",
    "http://notlocalhost/api",
    "http://localhost.evil.com/api",
    "http://evil.com/localhost",
  ])("refuses http on %s", (uri) => {
    expect(resourceUriProblem(uri)).toContain("must be https");
  });

  test("still allows https anywhere", () => {
    expect(resourceUriProblem("https://api.example.com/x")).toBeNull();
  });
});
