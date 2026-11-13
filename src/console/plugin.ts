import type { OAuthPrincipal } from "@softistx/janus-oauth";
import type { Access } from "./access";
import type { AdminEventRecorder } from "./admin-events/recorder";
import type { ConsoleDirectory, ConsoleExtras } from "./context";

/** Verifies the request's bearer token: its principal, or `null`. A store outage rejects. */
export type ConsoleAuthenticate = (
  request: Request,
) => Promise<OAuthPrincipal | null>;

export interface ConsoleDeps {
  authenticate: ConsoleAuthenticate;
  access: Access;
  directory: ConsoleDirectory;
  /** Where `ctx.audit` appends its events. */
  adminEvents: AdminEventRecorder;
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
 * down: 503), then `principal`, `can`, `canPlatform` and `audit` ride on the context.
 * No cookie is read and no tenant is resolved from the host: the token is the
 * whole credential.
 */
export function useConsole({
  authenticate,
  access,
  directory,
  adminEvents,
}: ConsoleDeps) {
  const principals = new WeakMap<Request, OAuthPrincipal>();
  // Ours, one per HTTP request: a client's `x-request-id` is never believed.
  const requestIds = new WeakMap<Request, string>();
  const requestIdOf = (request: Request) => {
    let requestId = requestIds.get(request);
    if (requestId === undefined) {
      requestId = crypto.randomUUID();
      requestIds.set(request, requestId);
    }
    return requestId;
  };
  return {
    async onRequest({
      request,
      endResponse,
    }: {
      request: Request;
      endResponse: (response: Response) => void;
    }) {
      // Called server to server: no CORS, so a preflight (no credential) is refused too.
      // Outside `useSameOriginJson` on purpose: a bearer header is no ambient credential.
      let principal: OAuthPrincipal | null;
      try {
        principal = await authenticate(request);
      } catch (error) {
        console.error("console: token verification failed", error);
        endResponse(refusal(503, "SERVICE_UNAVAILABLE", "Try again later"));
        return;
      }
      if (principal === null) {
        const presented =
          request.headers
            .get("authorization")
            ?.toLowerCase()
            .startsWith("bearer ") === true;
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
        // The actor is the token's user, never an argument.
        audit: (action, target) =>
          adminEvents.record({
            actor: principal.userId,
            action,
            tenantId: target.tenantId,
            target: { type: target.type, id: target.id },
            requestId: requestIdOf(context.request),
          }),
      });
    },
  };
}
