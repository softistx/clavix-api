import type { OAuthPrincipal } from "@softistx/janus-oauth";
import type { Access } from "./access";
import type { ConsoleDirectory, ConsoleExtras } from "./context";

/** Verifies the request's bearer token: its principal, or `null`. A store outage rejects. */
export type ConsoleAuthenticate = (
  request: Request,
) => Promise<OAuthPrincipal | null>;

export interface ConsoleDeps {
  authenticate: ConsoleAuthenticate;
  access: Access;
  directory: ConsoleDirectory;
}

const refusal = (
  status: number,
  code: string,
  message: string,
  headers: HeadersInit = {},
) =>
  new Response(
    JSON.stringify({ errors: [{ message, extensions: { code } }] }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      },
    },
  );

/**
 * The console's Yoga plugin: the bearer token is verified before anything is
 * parsed (no token, a forged, expired or other-audience one: 401; the store
 * down: 503), then `principal`, `can` and `canPlatform` ride on the context.
 * No cookie is read and no tenant is resolved from the host: the token is the
 * whole credential.
 */
export function useConsole({ authenticate, access, directory }: ConsoleDeps) {
  const principals = new WeakMap<Request, OAuthPrincipal>();
  return {
    async onRequest({
      request,
      endResponse,
    }: {
      request: Request;
      endResponse: (response: Response) => void;
    }) {
      // CORS preflights carry no credential; the console is called server to server.
      let principal: OAuthPrincipal | null;
      try {
        principal = await authenticate(request);
      } catch (error) {
        console.error("console: token verification failed", error);
        endResponse(refusal(503, "SERVICE_UNAVAILABLE", "Try again later"));
        return;
      }
      if (principal === null) {
        const presented = request.headers.get("authorization") !== null;
        endResponse(
          refusal(401, "UNAUTHENTICATED", "A valid console token is required", {
            "www-authenticate": presented
              ? 'Bearer realm="clavix-console", error="invalid_token"'
              : 'Bearer realm="clavix-console"',
          }),
        );
        return;
      }
      principals.set(request, principal);
    },
    onContextBuilding({
      context,
      extendContext,
    }: {
      context: { request: Request };
      extendContext: (extras: ConsoleExtras) => void;
    }) {
      const principal = principals.get(context.request);
      if (principal === undefined) return; // refused in onRequest; nothing runs
      extendContext({
        principal,
        access,
        directory,
        can: (permission, tenantId) =>
          access.can(principal.userId, permission, tenantId),
        canPlatform: (permission) =>
          access.canPlatform(principal.userId, permission),
      });
    },
  };
}
