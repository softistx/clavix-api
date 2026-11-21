import { definePlugin } from "@softistx/graxia";
import type { ExecutionResult } from "graphql";
import { GraphQLError } from "graphql";
import { isJsonAnswer } from "./media";

// graphql-js words a variable coercion failure as
// `Variable "$i" got invalid value <the value> at "i.clientSecret"; <reason>`,
// and the reason can quote the value again. A console variable can carry a
// client secret, so the value is never sent back: the error keeps the
// variable and the path, which is all a caller needs to find the mistake.
// Only variables are scrubbed: clients send their values as variables. Both
// endpoints use it: the console API and the hosted /graphql (e-mail codes,
// passkey answers, social flow values).
const COERCION = /^Variable "\$([A-Za-z_]\w*)" (?:got|has) invalid value\b/;
const AT = /\bat "([^"]*)";/;

/** The coercion error without the value it quotes; any other error as it is. */
export function withoutQuotedValue(error: GraphQLError): GraphQLError {
  const match = COERCION.exec(error.message);
  if (match === null) return error;
  const path = AT.exec(error.message)?.[1];
  const where = path === undefined ? "" : ` at "${path}"`;
  return new GraphQLError(
    `Variable "$${match[1]}" got an invalid value${where}`,
    { nodes: error.nodes ?? [], extensions: { code: "BAD_USER_INPUT" } },
  );
}

const scrub = (chunk: unknown): unknown => {
  const result = chunk as ExecutionResult | null;
  return result?.errors === undefined
    ? chunk
    : { ...result, errors: result.errors.map(withoutQuotedValue) };
};

/**
 * A graxia plugin that scrubs the coercion errors of every result: on the
 * stream transports (`onResultChunk`) and, since a plain JSON answer runs no
 * chunk hook, on the final response (`onResponse`).
 */
export const useWithoutQuotedValues = () =>
  definePlugin({
    name: "clavix-without-quoted-values",
    onResultChunk({ chunk, setChunk }) {
      setChunk(scrub(chunk));
    },
    async onResponse({ response, setResponse }) {
      if (!isJsonAnswer(response.headers.get("content-type"))) return;
      const body = await response.clone().text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return;
      }
      const scrubbed = Array.isArray(parsed)
        ? parsed.map(scrub)
        : scrub(parsed);
      if (JSON.stringify(scrubbed) === body) return;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      setResponse(
        new Response(JSON.stringify(scrubbed), {
          status: response.status,
          statusText: response.statusText,
          headers,
        }),
      );
    },
  });
