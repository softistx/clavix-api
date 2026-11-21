import { expect } from "bun:test";
import { z } from "zod";
import { at } from "~/body";

/** A GraphQL object read loosely: its `id`, and whatever else the spec looks at. */
export const rowSchema = z.looseObject({ id: z.string() });
export type Row = z.infer<typeof rowSchema>;
export const rowsSchema = z.array(rowSchema);

interface Answered {
  data?: Record<string, unknown> | null | undefined;
  errors?: unknown;
}

/** The object at `field` of an answer that has no errors. */
export const oneRow = (result: Answered, field: string): Row => {
  expect(result.errors).toBeUndefined();
  return at(result.data, field, rowSchema);
};

/** The list at `field` of an answer that has no errors. */
export const manyRows = (result: Answered, field: string): Row[] => {
  expect(result.errors).toBeUndefined();
  return at(result.data, field, rowsSchema);
};

/** A nested list (a field of a row) as rows. */
export const rowsOf = (value: unknown): Row[] => rowsSchema.parse(value);

/** A nested string (a field of a row). */
export const textOf = (value: unknown): string => z.string().parse(value);

/** A nested list of objects with no `id` (the fields of a type). */
export const recordsOf = (value: unknown): Record<string, unknown>[] =>
  z.array(z.record(z.string(), z.unknown())).parse(value);
