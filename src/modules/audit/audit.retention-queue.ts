import { defineQueue } from "@softistx/redis";
import { z } from "zod";

// The audit retention (D16), daily at 04:17 UTC (a `schedules` cron, fired
// while a worker runs). Deleting by age is idempotent, so every instance may
// run a worker.
export const auditRetention = defineQueue({
  name: "audit-retention",
  schema: z.object({}),
  attempts: 3,
  backoff: { base: "1m" },
  schedules: { daily: { cron: "17 4 * * *", data: {} } },
});
