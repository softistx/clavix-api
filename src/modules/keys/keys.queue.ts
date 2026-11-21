import { defineQueue } from "@softistx/redis";
import { z } from "zod";

// The hourly rotation tick (a `schedules` cron, fired while a worker runs).
// Every instance may run a worker: janus's step is idempotent and atomic.
export const keyRotation = defineQueue({
  name: "key-rotation",
  schema: z.object({}),
  attempts: 3,
  backoff: { base: "30s" },
  schedules: { hourly: { cron: "0 * * * *", data: {} } },
});
