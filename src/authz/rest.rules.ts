import type { RestRulesInput } from "@softistx/limix";
import { OAUTH_PATHS } from "@/oauth/routes";

const open = { public: true } as const;

/**
 * The REST routes' rules. Every route is `public`, and none is unguarded:
 * each authenticates the caller itself, with what limix has no vocabulary for.
 * - the probes, the logo, the webauthn origins: open by design; the TLS ask
 *   checks a shared secret;
 * - the OAuth endpoints: the protocol's own client authentication (client
 *   secret, DPoP, a bearer token) inside janus;
 * - `/media/avatar`: the session cookie or a token, checked by the route with
 *   its upload budget;
 * - `/graphql` and `/console/graphql`: not judged here, their fields are
 *   (`hosted.rules.ts`, `console.rules.ts`); the route only carries the POST;
 * - `/console/audit/export`: the console token and its permission, checked
 *   by the route against the tenant it names.
 * Only the routes the app mounts get a rule (a rule no route takes makes the
 * guard refuse everything); `mounted` says which are. `*` is every method of the route: the framework answers 404 or 405 itself.
 */
export const restRulesFor = (mounted: { oauth: boolean; console: boolean }) =>
  ({
    "/healthz": { GET: open },
    "/readyz": { "*": open },
    "/branding/logo": { "*": open },
    "/internal/tls/ask": { "*": open },
    "/.well-known/webauthn": { "*": open },
    "/media/avatar": { PUT: open },
    "/media/avatar/:key": { GET: open },
    "/graphql": { "*": open },
    ...(mounted.console
      ? {
          "/console/graphql": { "*": open },
          "/console/audit/export": { "*": open },
        }
      : {}),
    ...(mounted.oauth
      ? Object.fromEntries(OAUTH_PATHS.map((path) => [path, { "*": open }]))
      : {}),
  }) satisfies RestRulesInput;
