import { defineQueue } from "@softistx/redis";
import { z } from "zod";

// The TXT recheck of the verified domains, every 6 hours (a `schedules` cron,
// fired while a worker runs). Every instance may run a worker: a pass only
// moves a domain forward by what DNS says now, and is safe to run twice.
export const domainRecheck = defineQueue({
  name: "domain-recheck",
  schema: z.object({}),
  attempts: 3,
  backoff: { base: "1m" },
  schedules: { sixHourly: { cron: "0 */6 * * *", data: {} } },
});
