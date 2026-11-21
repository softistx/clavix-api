import { GraphQLError } from "graphql";

/**
 * D10 and RFC 9470: a request whose `acr_values` Clavix cannot issue (no gap
 * the user could close: `missing` is empty) is refused to the client, which
 * gets `error=unmet_authentication_requirements` on its redirect, instead of
 * a page that waits for a proof nobody can give. A gap the user can close
 * (a second factor, a fresh proof, an enrolment) stays a refusal of the call
 * (403, `missing`), and the request stays pending for the step-up.
 */
export const isUnreachable = (error: unknown) =>
  error instanceof GraphQLError &&
  error.extensions["code"] === "UNMET_AUTHENTICATION_REQUIREMENTS" &&
  Array.isArray(error.extensions["missing"]) &&
  error.extensions["missing"].length === 0;

/** Denies the pending request with `unmet_authentication_requirements` (nxgt-janus#949); the answer is the client's redirect. */
export async function denyUnreachable(
  server: {
    deny(
      id: string,
      options: {
        error: "unmet_authentication_requirements";
        description: string;
      },
    ): Promise<{ redirectTo: string }>;
  },
  id: string,
) {
  const { redirectTo } = await server.deny(id, {
    error: "unmet_authentication_requirements",
    description: "the authentication requested cannot be met",
  });
  return { redirectTo };
}
