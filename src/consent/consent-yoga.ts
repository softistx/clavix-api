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
  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    plugins,
    maskedErrors,
    graphqlEndpoint: CONSENT_GRAPHQL_PATH,
    landingPage: false,
    graphiql: false,
    // The hosted page is on the tenant's own host: no cross-origin caller.
    cors: false,
  });
  return { fetch: (request) => guarded(request, yoga.fetch) };
}

const refuse = (status: number, message: string) =>
  Response.json({ errors: [{ message }] }, { status });

// The cookie is the credential, so a foreign page must not reach approve or
// deny (a sibling tenant host is same-site, SameSite=Lax does not stop it):
// only JSON posts (not a CORS "simple" form post), and an Origin, when sent,
// must be the request's own.
function guarded(
  request: Request,
  next: (request: Request) => Response | Promise<Response>,
) {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return refuse(403, "cross-origin request refused");
  }
  if (
    request.method === "POST" &&
    !(request.headers.get("content-type") ?? "").startsWith("application/json")
  ) {
    return refuse(415, "content-type must be application/json");
  }
  return next(request);
}
