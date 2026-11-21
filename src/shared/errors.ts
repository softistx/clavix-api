import type { ErrorHttp } from "@softistx/graxia";
import { GraphQLError } from "graphql";
import type { ErrorCode } from "@/i18n/codes";

/**
 * The JSON body of a refusal answered outside GraphQL (a route, a plugin's
 * early answer): `{ errors: [{ message, extensions: { code } }] }`, the shape
 * `fail()` gives a GraphQL error.
 */
export const errorBody = (code: ErrorCode, message: string): string =>
  JSON.stringify({ errors: [{ message, extensions: { code } }] });

export interface FailOptions {
  /** The HTTP status graxia answers a single operation with (`extensions.http.status`). */
  status?: number | undefined;
  /** The input field the refusal is about (`extensions.field`). */
  field?: string | undefined;
  /** Seconds until the call may be retried: `extensions.retryAfter` and the `Retry-After` header. */
  retryAfter?: number | undefined;
  /** Response headers beside the status (`extensions.http.headers`). */
  headers?: Record<string, string> | undefined;
  /** Other extensions the contract carries (`failures`, `missing`, `oauthError`…). */
  extra?: Record<string, unknown> | undefined;
}

/**
 * The one way to refuse an operation (AGENTS.md "Errors"): `extensions.code`
 * is the code, stable and in the inventory (`ErrorCode`, so tsc refuses an
 * unknown one); `message` is the English text clients may show. The other
 * extensions are optional: `http.status` (graxia answers a single operation
 * with it), `http.headers`, `field`, `retryAfter` and `extra`.
 */
export function fail(
  code: ErrorCode,
  message: string,
  options: FailOptions = {},
): GraphQLError {
  const { status, field, retryAfter, extra } = options;
  const headers = {
    ...(retryAfter === undefined ? {} : { "retry-after": String(retryAfter) }),
    ...options.headers,
  };
  const http = {
    ...(status === undefined ? {} : { status }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  } satisfies ErrorHttp;
  return new GraphQLError(message, {
    extensions: {
      code,
      ...extra,
      ...(retryAfter === undefined ? {} : { retryAfter }),
      ...(Object.keys(http).length === 0 ? {} : { http }),
      ...(field === undefined ? {} : { field }),
    },
  });
}
