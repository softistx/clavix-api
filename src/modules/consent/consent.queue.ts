import { defineQueue } from "@softistx/redis";
import { z } from "zod";

// The revocation of a replaced holder's OAuth grants, queued when the inline
// revocation of a social sign-in failed (clavix-api #353). janus reports
// `replaced` once, so nothing else would try again. `revokeAll` is idempotent,
// so a job may run twice and every instance may run a worker. About 15 hours
// of retries (8 attempts, 1 min doubling, capped at 1 h).
export const grantsRevoke = defineQueue({
  name: "grants-revoke",
  schema: z.object({ tenantId: z.string(), userId: z.string() }),
  attempts: 8,
  backoff: { base: "1m", max: "1h" },
  keepFailed: "30d",
});
