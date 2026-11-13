import { defineQueue } from "@softistx/redis";
import { z } from "zod";

// The daily purge tick (a `schedules` cron, fired while a worker runs). Every
// instance may run a worker: `claimPurge` is atomic and a purge is resumable.
export const tenantPurge = defineQueue({
  name: "tenant-purge",
  schema: z.object({}),
  attempts: 3,
  backoff: { base: "5m" },
  schedules: { daily: { cron: "17 3 * * *", timezone: "UTC", data: {} } },
});
