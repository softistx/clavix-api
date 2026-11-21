/** The list without its repeats, in first-seen order. */
export const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];

/** A plain object (not null, not an array). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The property of an object value, `undefined` when the value is no object or has none (a read with no cast). */
export const propertyOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined;

/** The strings of a value that is an array, in order; none for anything else (a read with no cast). */
export const stringListOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/** Whether a value is one of the listed strings (narrows it to their union, no cast). */
export const isOneOf = <T extends string>(
  list: readonly T[],
  value: unknown,
): value is T => list.some((item) => item === value);

/** Whether a list holds at least one item (narrows it to a non-empty tuple, no cast). */
export const isNonEmpty = <T>(
  list: readonly T[],
): list is readonly [T, ...T[]] => list.length > 0;

/** The entries of an object that hold a string, as a record (a read with no cast). */
export const stringsOf = (source: object): Record<string, string> => {
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") strings[key] = value;
  }
  return strings;
};
