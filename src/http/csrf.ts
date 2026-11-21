import { definePlugin } from "@softistx/graxia";

/**
 * The header every GraphQL request carries once `CLAVIX_REQUIRE_CLIENT_HEADER`
 * is on: any non-empty value, the client's name (`clavix-ui`, `apollo-sandbox`).
 * A browser sends a custom header only after a CORS preflight, which a page of
 * another origin does not pass, and a form or a plain GET cannot send one.
 */
export const CLIENT_HEADER = "x-clavix-client";

// A browser opening the IDE page (a GET that accepts HTML, with no `query`)
// sends no custom header; the page runs no operation.
const isPageRequest = (request: Request) =>
  request.method === "GET" &&
  (request.headers.get("accept") ?? "").includes("text/html") &&
  !new URL(request.url).searchParams.has("query");

const refused = () =>
  new Response(
    // The shape of `errorBody` (src/shared/errors.ts), built here: importing
    // it from this file, the first of src/http, makes madge report five more
    // cycles through the `ErrorCode` type. The code is in auth.errors.ts.
    JSON.stringify({
      errors: [
        {
          message: `The ${CLIENT_HEADER} header is required`,
          extensions: { code: "CLIENT_HEADER_REQUIRED" },
        },
      ],
    }),
    {
      status: 403,
      // No CORS header: a foreign page cannot read the answer either.
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );

/**
 * A graxia plugin for `/graphql` and `/console/graphql`. `required` comes from
 * the caller (`env.CLAVIX_REQUIRE_CLIENT_HEADER` in `createApp`), never a
 * default here. Off, nothing is checked: any value, or none, passes (no allow
 * list exists, so a present header is never refused either). On, a request with
 * no non-blank header is answered 403 `CLIENT_HEADER_REQUIRED` before it is
 * parsed, so it reaches no resolver.
 */
export const useClientHeader = (required: boolean) =>
  definePlugin({
    name: "clavix-client-header",
    onRequest({ request, respond }) {
      if (!required) return;
      if (request.headers.get(CLIENT_HEADER)?.trim()) return;
      if (isPageRequest(request)) return;
      respond(refused());
    },
  });
