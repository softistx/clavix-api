import { defineUniqueCounter } from "@softistx/redis";

/** A calendar month in UTC, `YYYY-MM`. */
export const monthOf = (date: Date) => date.toISOString().slice(0, 7);

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Whether `value` is a `YYYY-MM` month. */
export const isMonth = (value: string) => MONTH.test(value);

// Distinct users who opened a session or refreshed a token, per tenant and
// month (a Redis HyperLogLog, ~1 % error). A key outlives its month by a year,
// so a past month can still be read; `usageCounters` keeps what was read.
export const monthlyActiveUsers = defineUniqueCounter({
  name: "clavix:usage.mau",
  key: ({ tenantId, month }: { tenantId: string; month: string }) =>
    `${tenantId}:${month}`,
  ttl: "400d",
});
