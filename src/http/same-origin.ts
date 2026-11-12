import { parse } from "graphql";

// The cookie is the credential and a sibling tenant host is same-site (SameSite=Lax does not stop
// it), so every /graphql request must come from the tenant's own origin and, for a POST, as JSON
// (not a CORS "simple" form post). `Origin: null` (a sandboxed frame) and other junk have no host:
// they never match.
const hostOf = (value: string): string | null => {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
};

export function sameOriginJson(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Hosts, not origins: behind a TLS-terminating proxy `request.url` may say http while the
  // browser's Origin says https. A request with no Origin (not a browser) passes; the cookie is `__Host-`.
  if (origin !== null && hostOf(origin) !== hostOf(request.url)) return false;
  return (
    request.method !== "POST" ||
    (request.headers.get("content-type") ?? "").startsWith("application/json")
  );
}

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
      const { query } = JSON.parse(text) as { query?: unknown };
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

const refusal = (status: number, code: string, message: string) =>
  new Response(
    JSON.stringify({ errors: [{ message, extensions: { code } }] }),
    {
      status,
      // No CORS header: a foreign page cannot read the answer either.
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );

/**
 * A Yoga plugin, applied once to every /graphql operation: a foreign `Origin`, `Origin: null`
 * or a non-JSON POST is answered before anything is parsed or run. A consent operation sees
 * `NOT_FOUND` (404, as no such request); every other operation sees `FORBIDDEN` (403). Neither
 * answer carries a CORS header.
 */
export const useSameOriginJson = () => ({
  async onRequest({
    request,
    endResponse,
  }: {
    request: Request;
    endResponse: (response: Response) => void;
  }) {
    if (sameOriginJson(request)) return;
    endResponse(
      (await asksOnlyForConsent(request))
        ? refusal(404, "NOT_FOUND", "Not found")
        : refusal(403, "FORBIDDEN", "Cross-origin requests are not allowed"),
    );
  },
});
