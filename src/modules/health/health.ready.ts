/** One dependency `/readyz` checks: resolves when it answers, rejects or resolves `false` when not. */
export type ReadyCheck = () => Promise<boolean | undefined>;

export interface ReadyDeps {
  /** A Mongo `ping`. */
  mongo: ReadyCheck;
  /** A Redis `PING`; `null` when the app has no Redis (development only). */
  redis: ReadyCheck | null;
  /** Longest wait per dependency, in ms. */
  timeoutMs?: number;
}

export interface ReadyReport {
  status: "ok" | "unavailable";
  checks: Record<string, "ok" | "down">;
}

const run = async (check: ReadyCheck, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      check(),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    return result === false ? "down" : "ok";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The readiness report: Mongo and Redis answered. It carries no error text
 * (the endpoint is public); the logs and `docs/operations.md` say how to dig.
 */
export async function readiness(deps: ReadyDeps): Promise<ReadyReport> {
  const timeoutMs = deps.timeoutMs ?? 2_000;
  const names = ["mongo", ...(deps.redis === null ? [] : ["redis"])];
  const results = await Promise.all([
    run(deps.mongo, timeoutMs),
    ...(deps.redis === null ? [] : [run(deps.redis, timeoutMs)]),
  ]);
  const checks = Object.fromEntries(
    names.map((name, i) => [name, results[i] ?? "down"]),
  );
  return {
    status: results.every((r) => r === "ok") ? "ok" : "unavailable",
    checks,
  };
}
