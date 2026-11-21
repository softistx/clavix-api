import { z } from "zod";

/** A GraphQL response body: `data` and the errors with the extensions a spec reads. */
export const gqlBody = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
        extensions: z
          .looseObject({
            code: z.string().optional(),
            field: z.string().optional(),
            missing: z.array(z.string()).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});
export type GqlResult = z.output<typeof gqlBody>;

/** The body of a GraphQL response, parsed: a body that is not one fails the spec. */
export const gqlOf = async (response: Response): Promise<GqlResult> =>
  gqlBody.parse(await response.json());
