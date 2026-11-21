import { describe, expect, test } from "bun:test";
import { createTestApp } from "~/app";
import { readiness } from "./health.ready";

const up = async () => true;
const down = async () => {
  throw new Error("connection refused");
};

describe("readiness", () => {
  test("ok when Mongo and Redis answer", async () => {
    expect(await readiness({ mongo: up, redis: up })).toEqual({
      status: "ok",
      checks: { mongo: "ok", redis: "ok" },
    });
  });

  test("unavailable when one is down, without the error text", async () => {
    const report = await readiness({ mongo: up, redis: down });
    expect(report).toEqual({
      status: "unavailable",
      checks: { mongo: "ok", redis: "down" },
    });
    expect(JSON.stringify(report)).not.toContain("refused");
  });

  test("a check answering false or too late is down", async () => {
    const slow = () => new Promise<boolean>(() => {});
    const report = await readiness({
      mongo: async () => false,
      redis: slow,
      timeoutMs: 20,
    });
    expect(report.checks).toEqual({ mongo: "down", redis: "down" });
  });

  test("no Redis configured: only Mongo is checked", async () => {
    expect((await readiness({ mongo: up })).checks).toEqual({ mongo: "ok" });
  });
});

describe("GET /readyz and /healthz", () => {
  test("/readyz answers 200 against the test Mongo", async () => {
    const response = await createTestApp().request("/readyz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      checks: { mongo: "ok" },
    });
  });

  test("/readyz answers 503 when a dependency is down", async () => {
    const app = createTestApp({
      ready: () => readiness({ mongo: down, redis: up }),
    });
    const response = await app.request("/readyz");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).status).toBe("unavailable");
  });

  test("/healthz does not touch the dependencies", async () => {
    const app = createTestApp({
      ready: () => {
        throw new Error("must not be called");
      },
    });
    expect((await app.request("/healthz")).status).toBe(200);
  });
});
