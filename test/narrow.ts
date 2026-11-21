import type { z } from "zod";

/** A value a spec expects to be there: throws (failing the spec) on `null` or `undefined`. */
export function defined<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be defined`);
  }
  return value;
}

/** The value as an instance of `type`: throws (failing the spec) when it is not one. */
export function instance<T>(
  value: unknown,
  type: abstract new (...args: never[]) => T,
): T {
  if (!(value instanceof type)) {
    throw new Error(`expected an instance of ${type.name}`);
  }
  return value;
}

/** The value parsed by `schema`: the typed read of an `unknown` (throws with the zod issues). */
export const parsed = <S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> => schema.parse(value);

/** The value as a record, for a spec that reads fields by name. */
export function recordOf(
  value: unknown,
  what = "value",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${what} to be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}
