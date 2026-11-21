import { type GqlResult, gqlOf } from "~/gql";

/** A GraphQL answer as the specs read it: the status, the data (never `undefined`), the errors and the cookies set. */
export interface Answer {
  status: number;
  data: Record<string, unknown> | null;
  errors?: GqlResult["errors"];
  cookies: string[];
}

/** The `Answer` of a response: the body is parsed (a body that is not a GraphQL one fails the spec). */
export async function answerOf(response: Response): Promise<Answer> {
  const body = await gqlOf(response);
  return {
    status: response.status,
    data: body.data ?? null,
    ...(body.errors === undefined ? {} : { errors: body.errors }),
    cookies: response.headers.getSetCookie(),
  };
}
