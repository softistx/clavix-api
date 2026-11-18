import { defineQueue } from "@softistx/redis";
import { z } from "zod";

// The clean-up of the expired rolled webhook secrets, daily at 04:17 UTC (a
// `schedules` cron, fired while a worker runs). Idempotent, so every instance
// may run a worker.
export const webhookSecretsPrune = defineQueue({
  name: "webhook-secrets-prune",
  schema: z.object({}),
  attempts: 3,
  backoff: { base: "1m" },
  schedules: { daily: { cron: "37 4 * * *", data: {} } },
});
