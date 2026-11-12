import { createSchema, createYoga } from "graphql-yoga";
import { type ConsentOptions, consentGraphQL } from "./consent";

/** The path of the consent API on a tenant's host. */
export const CONSENT_GRAPHQL_PATH = "/graphql/consent";

export type ConsentHandle = {
  fetch: (request: Request) => Response | Promise<Response>;
};

/** The consent API as its own Yoga server (until slice E1's server takes its parts in). */
export function createConsentYoga(options: ConsentOptions): ConsentHandle {
  const { typeDefs, resolvers, plugins, maskedErrors } =
    consentGraphQL(options);
  return createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    plugins,
    maskedErrors,
    graphqlEndpoint: CONSENT_GRAPHQL_PATH,
    landingPage: false,
    graphiql: false,
  });
}
