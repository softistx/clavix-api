import { defineQueue } from "@softistx/redis";
import { z } from "zod";

// What a social replacement leaves of the previous holder (their attribute
// values and picture), erased from the queue so a failure is retried: janus
// reports `replaced` once, so a retried sign-in would not erase. The erase is
// idempotent, so a job may run twice and every instance may run a worker.
// Same policy as `grants-revoke`: about 15 hours of retries (8 attempts,
// 1 min doubling, capped at 1 h).
export const eraseReplaced = defineQueue({
  name: "erase-replaced",
  schema: z.object({ tenantId: z.string(), userId: z.string() }),
  attempts: 8,
  backoff: { base: "1m", max: "1h" },
  keepFailed: "30d",
});
