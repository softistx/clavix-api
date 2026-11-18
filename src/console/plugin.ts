import type { OAuthPrincipal } from "@softistx/janus-oauth";
import type { Access } from "./access";
import type { AdminEventRecorder } from "./admin-events/recorder";
import type {
  ConsoleActivity,
  ConsoleAdmins,
  ConsoleDirectory,
  ConsoleExtras,
  ConsoleUsers,
} from "./context";
import type { Exclusive } from "./exclusive";

/**
 * A refused `DPoP` request: the challenge to answer (RFC 9449 §7.1), with the
 * current nonce when the proof lacked it (`use_dpop_nonce`).
 */
export interface ConsoleDPoPRefusal {
  refused: {
    error: string;
    description?: string | undefined;
    nonce?: string | undefined;
  };
}

/**
 * Verifies the request's `Bearer` or `DPoP` token: its principal, the DPoP
 * refusal to challenge with, or `null` (any other refusal). A store outage rejects.
 */
export type ConsoleAuthenticate = (
  request: Request,
  /** The path the client called when it is not the GraphQL one (a DPoP proof's `htu` names it). */
  path?: string,
) => Promise<OAuthPrincipal | ConsoleDPoPRefusal | null>;

/** The `WWW-Authenticate` of a refused DPoP request, and its nonce header. */
function dpopChallenge({ refused }: ConsoleDPoPRefusal): HeadersInit {
  const parts = [
    'realm="clavix-console"',
    `error="${refused.error}"`,
    ...(refused.description === undefined
      ? []
      : [
          `error_description="${refused.description.replace(/[\\"]/g, "\\$&")}"`,
        ]),
    'algs="ES256 EdDSA"',
  ];
  return {
    "www-authenticate": `DPoP ${parts.join(", ")}`,
    ...(refused.nonce === undefined ? {} : { "dpop-nonce": refused.nonce }),
  };
}

export interface ConsoleDeps {
  authenticate: ConsoleAuthenticate;
  access: Access;
  directory: ConsoleDirectory;
  admins: ConsoleAdmins;
  users: ConsoleUsers;
  exclusive: Exclusive;
  /** Where `ctx.audit` appends its events. */
  adminEvents: AdminEventRecorder;
  /** The readers of the activity logs. */
  activity: ConsoleActivity;
  /** The audit export's limits; the real ones (100 000 rows, the clock) by default. */
  auditExport?: { maxRows?: number; now?: () => Date };
}

export const refusal = (
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
 * Verifies the request's token: the principal, or the response that refuses it
 * (no token, a forged, expired or other-audience one: 401 with its challenge;
 * the store down: 503). Shared by the GraphQL API and the audit export.
 */
export async function authenticated(
  authenticate: ConsoleAuthenticate,
  request: Request,
  path?: string,
): Promise<OAuthPrincipal | Response> {
  let principal: OAuthPrincipal | ConsoleDPoPRefusal | null;
  try {
    principal = await authenticate(request, path);
  } catch (error) {
    console.error("console: token verification failed", error);
    return refusal(503, "SERVICE_UNAVAILABLE", "Try again later");
  }
  if (principal !== null && "refused" in principal) {
    return refusal(
      401,
      "UNAUTHENTICATED",
      "A valid console token is required",
      dpopChallenge(principal),
    );
  }
  if (principal === null) {
    const presented =
      request.headers
        .get("authorization")
        ?.toLowerCase()
        .startsWith("bearer ") === true;
    return refusal(
      401,
      "UNAUTHENTICATED",
      "A valid console token is required",
      {
        "www-authenticate": presented
          ? 'Bearer realm="clavix-console", error="invalid_token"'
          : 'Bearer realm="clavix-console"',
      },
    );
  }
  return principal;
}

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
  admins,
  users,
  exclusive,
  adminEvents,
  activity,
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
      const principal = await authenticated(authenticate, request);
      if (principal instanceof Response) {
        endResponse(principal);
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
        admins,
        users,
        exclusive,
        activity,
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
