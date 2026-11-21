import { defineQueue } from "@softistx/redis";
import { z } from "zod";

// The clean-up of the agents that never got a grant, daily at 03:41 UTC (a
// `schedules` cron, fired while a worker runs). A pass only deletes what is
// still unused and deleting is idempotent, so every instance may run a worker.
export const agentsPrune = defineQueue({
  name: "agents-prune",
  schema: z.object({}),
  attempts: 3,
  backoff: { base: "1m" },
  schedules: { daily: { cron: "41 3 * * *", data: {} } },
});
