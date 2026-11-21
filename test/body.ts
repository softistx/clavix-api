import type { z } from "zod";

const walk = (
  data: Record<string, unknown> | null | undefined,
  path: string,
): unknown => {
  let node: unknown = data;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = Reflect.get(node, key);
  }
  return node;
};

/**
 * Reads a GraphQL response body by dotted path (`"verifySignInCode.user.id"`).
 * With a zod schema it returns the parsed value, typed by the schema and
 * checked at run time (a spec that reads a shape that is not there fails on
 * the read, with the issue); without one it returns `unknown`, `undefined` for
 * a missing step, for a spec that only compares the value.
 */
export function at(
  data: Record<string, unknown> | null | undefined,
  path: string,
): unknown;
export function at<S extends z.ZodType>(
  data: Record<string, unknown> | null | undefined,
  path: string,
  schema: S,
): z.output<S>;
export function at(
  data: Record<string, unknown> | null | undefined,
  path: string,
  schema?: z.ZodType,
): unknown {
  const node = walk(data, path);
  return schema === undefined ? node : schema.parse(node);
}
