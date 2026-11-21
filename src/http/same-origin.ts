import { definePlugin } from "@softistx/graxia";
import { parse } from "graphql";
import { errorBody } from "@/shared/errors";
import { propertyOf } from "@/shared/values";

/** The root fields of the consent API: a refused request that asks only for these sees `NOT_FOUND`, as if no such request existed. */
export const CONSENT_FIELDS: ReadonlySet<string> = new Set([
  "oauthRequest",
  "approveOAuthRequest",
  "denyOAuthRequest",
  "connectedApps",
  "revokeConnectedApp",
]);

// The query of a refused request, read from its JSON or form body (a parse failure is no query).
async function queryOf(request: Request): Promise<string | null> {
  try {
    const type = request.headers.get("content-type") ?? "";
    const text = await request.clone().text();
    if (type.startsWith("application/json")) {
      const query = propertyOf(JSON.parse(text), "query");
      return typeof query === "string" ? query : null;
    }
    return new URLSearchParams(text).get("query");
  } catch {
    return null;
  }
}

async function asksOnlyForConsent(request: Request): Promise<boolean> {
  const query = await queryOf(request);
  if (query === null) return false;
  try {
    const fields = parse(query).definitions.flatMap((definition) =>
      definition.kind === "OperationDefinition"
        ? definition.selectionSet.selections.flatMap((selection) =>
            selection.kind === "Field" ? [selection.name.value] : [],
          )
        : [],
    );
    return fields.length > 0 && fields.every((f) => CONSENT_FIELDS.has(f));
  } catch {
    return false;
  }
}

const notFound = () =>
  new Response(errorBody("NOT_FOUND", "Not found"), {
    status: 404,
    // No CORS header: a foreign page cannot read the answer either.
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const forbidden = () =>
  new Response(
    errorBody("FORBIDDEN", "Cross-origin requests are not allowed"),
    {
      status: 403,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );

function sameHost(origin: string, url: string): boolean {
  try {
    return new URL(origin).host === new URL(url).host;
  } catch {
    return false;
  }
}

// A request a browser could send on the user's behalf from another page: a
// foreign `Origin` (`null` included), or a POST that is not JSON. A request
// with no `Origin` is no browser's cross-site one and passes.
function crossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  // The host, not the full origin: behind Caddy the API sees `http://host`
  // while the browser sends `https://host`. A `null` or malformed Origin is refused.
  if (origin !== null && !sameHost(origin, request.url)) return true;
  return (
    request.method === "POST" &&
    !(request.headers.get("content-type") ?? "").startsWith("application/json")
  );
}

/**
 * Applied once to every /graphql operation (the cookie is the credential): a
 * foreign `Origin`, `Origin: null` or a non-JSON POST is answered before
 * anything is parsed or run. A consent operation sees `NOT_FOUND` (404, as no
 * such request); every other operation sees `FORBIDDEN` (403). Neither answer
 * carries a CORS header. graxia's own CSRF header check runs before it and
 * stays on: a GET or a non-JSON POST needs `x-graphql-csrf` to reach this guard.
 */
export const useSameOriginJson = () =>
  definePlugin({
    name: "clavix-same-origin",
    async onRequest({ request, respond }) {
      if (!crossSite(request)) return;
      respond((await asksOnlyForConsent(request)) ? notFound() : forbidden());
    },
  });
