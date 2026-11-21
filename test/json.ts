import { z } from "zod";

/** The JSON body of a response, parsed by `schema` (throws with the zod issues when it does not fit). */
export const jsonOf = async <S extends z.ZodType>(
  response: Response,
  schema: S,
): Promise<z.output<S>> => schema.parse(await response.json());

/** The body of an OAuth token response, as far as a spec reads it. */
export const tokenBody = z.looseObject({
  access_token: z.string(),
  id_token: z.string().optional(),
  refresh_token: z.string().nullish(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
});
export type TokenBody = z.output<typeof tokenBody>;

/** The body of an OAuth error response. */
export const errorBody = z.looseObject({
  error: z.string(),
  error_description: z.string().optional(),
});
