import type { UsageMeter } from "./usage.types";

/** A calendar month in UTC, `YYYY-MM`. */
export const monthOf = (date: Date) => date.toISOString().slice(0, 7);

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Whether `value` is a `YYYY-MM` month. */
export const isMonth = (value: string) => MONTH.test(value);

/** What a tenant used of a quota; `null` (no limit) is never exceeded. */
export const meter = (used: number, quota: number | null): UsageMeter => ({
  used,
  quota,
  exceeded: quota !== null && used > quota,
});

/** A failure's message, for a log line. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
