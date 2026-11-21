import type { z } from "zod";
import type { GqlResult } from "~/gql";

/** One field of a GraphQL result's data, known to be there, parsed by `schema`. */
export const fieldOf = <S extends z.ZodType>(
  result: GqlResult,
  key: string,
  schema: S,
): z.output<S> => {
  const value = result.data?.[key];
  if (value === undefined || value === null) {
    throw new Error(`no ${key}: ${JSON.stringify(result.errors)}`);
  }
  return schema.parse(value);
};
