import type { ExecutionResult } from "graphql";
import { GraphQLError } from "graphql";

// graphql-js words a variable coercion failure as
// `Variable "$i" got invalid value <the value> at "i.clientSecret"; <reason>`,
// and the reason can quote the value again. A console variable can carry a
// client secret, so the value is never sent back: the error keeps the
// variable and the path, which is all a caller needs to find the mistake.
// Only variables are scrubbed: clients send their values as variables. Both
// endpoints use it: the console API and the hosted /graphql (e-mail codes,
// passkey answers, social flow values).
const COERCION = /^Variable "\$([A-Za-z_]\w*)" got invalid value\b/;
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

type Result = ExecutionResult | readonly ExecutionResult[];

const scrub = (one: ExecutionResult): ExecutionResult =>
  one.errors === undefined
    ? one
    : { ...one, errors: one.errors.map(withoutQuotedValue) };

/** A GraphQL plugin that scrubs the coercion errors of every result. */
export function useWithoutQuotedValues() {
  return {
    onResultProcess({
      result,
      setResult,
    }: {
      result: Result;
      setResult: (result: Result) => void;
    }) {
      setResult(
        Array.isArray(result)
          ? result.map(scrub)
          : scrub(result as ExecutionResult),
      );
    },
  };
}
