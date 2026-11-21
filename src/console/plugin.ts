import { createStateKey, definePlugin } from "@softistx/graxia";
import type { OAuthUserPrincipal } from "@softistx/janus-oauth";
import type { ErrorCode } from "@/i18n/codes";
import { AdminsService } from "@/modules/admins/admins.service";
import { errorBody } from "@/shared/errors";
import type { Access } from "./access";
import type { AdminEventRecorder } from "./admin-events/recorder";
import type { ExportThrottle } from "./audit-export/throttle";
import type { ConsoleBudgets } from "./budgets";
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
) => Promise<OAuthUserPrincipal | ConsoleDPoPRefusal | null>;

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
  /** The budgets of the test webhooks and the invitations (`budgets.ts`); none without Redis. */
  budgets?: ConsoleBudgets | undefined;
  /** Where `ctx.audit` appends its events. */
  adminEvents: AdminEventRecorder;
  /** The readers of the activity logs. */
  activity: ConsoleActivity;
  /** The clock (the audit export's range floor). */
  now: () => Date;
  /** Where a swallowed failure (token check, export record) is logged, with its cause. */
  reportError: (message: string, cause: unknown) => void;
  /** The audit export's limits: `maxRows` is the real one (100 000 rows) when left out. */
  auditExport: {
    maxRows?: number;
    /** Per-tenant export budget (`unthrottled` without Redis). */
    throttle: ExportThrottle;
  };
}

export const refusal = (
  status: number,
  code: ErrorCode,
  message: string,
  headers: HeadersInit = {},
) =>
  new Response(errorBody(code, message), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });

/**
 * Verifies the request's token: the principal, or the response that refuses it
 * (no token, a forged, expired or other-audience one: 401 with its challenge;
 * the store down: 503). Shared by the GraphQL API and the audit export.
 */
export async function authenticated(
  authenticate: ConsoleAuthenticate,
  reportError: ConsoleDeps["reportError"],
  request: Request,
  path?: string,
): Promise<OAuthUserPrincipal | Response> {
  let principal: OAuthUserPrincipal | ConsoleDPoPRefusal | null;
  try {
    principal = await authenticate(request, path);
  } catch (error) {
    reportError("console: token verification failed", error);
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

/** The verified principal of the request, passed from `onRequest` to `onContext`. */
const principalKey = createStateKey<OAuthUserPrincipal>("console-principal");

/**
 * The console's graxia plugin: the bearer token is verified before anything is
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
  budgets,
  adminEvents,
  activity,
  reportError,
}: ConsoleDeps) {
  const members = new AdminsService({ access, directory, exclusive });
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
  return definePlugin({
    name: "clavix-console",
    // Called server to server: no CORS, so a preflight (no credential) is refused too.
    // A bearer header is no ambient credential, so no same-origin guard applies.
    async onRequest({ request, respond, state }) {
      const principal = await authenticated(authenticate, reportError, request);
      if (principal instanceof Response) {
        respond(principal);
        return;
      }
      state.set(principalKey, principal);
    },
    onContext({ request, state }): ConsoleExtras | undefined {
      const principal = state.get(principalKey);
      if (principal === undefined) return undefined; // refused in onRequest; nothing runs
      return {
        principal,
        access,
        directory,
        admins,
        members,
        users,
        exclusive,
        budgets,
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
            requestId: requestIdOf(request),
          }),
      };
    },
  });
}
