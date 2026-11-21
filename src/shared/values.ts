/** The list without its repeats, in first-seen order. */
export const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];

/** A plain object (not null, not an array). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
