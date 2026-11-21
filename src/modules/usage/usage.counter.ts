import { defineUniqueCounter } from "@softistx/redis";

// Distinct users who opened a session or refreshed a token, per tenant and
// month (a Redis HyperLogLog, ~1 % error). A key outlives its month by a year,
// so a past month can still be read; `usageCounters` keeps what was read.
export const monthlyActiveUsers = defineUniqueCounter({
  name: "clavix:usage.mau",
  key: ({ tenantId, month }: { tenantId: string; month: string }) =>
    `${tenantId}:${month}`,
  ttl: "400d",
});
