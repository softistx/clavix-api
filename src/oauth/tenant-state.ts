import { propertyOf } from "@/shared/values";
import { isLive, TENANT_SUSPENDED } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";

/** The paths that open or extend a session; the others keep answering for a suspended tenant (ADR-0039). */
const REFUSED_PATHS = new Set([
  "/authorize",
  "/par",
  "/device_authorization",
  "/token",
  "/register",
]);

/** The 403 a suspended or deleted tenant's session-opening paths answer. */
export const suspendedResponse = () =>
  Response.json(
    {
      error: "access_denied",
      error_description: "This service is suspended",
      code: TENANT_SUSPENDED,
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );

export interface TenantStateOptions {
  resolver: Pick<TenantResolver, "resolveRequest">;
  /** Called after a token was issued or refreshed, with the tenant and the user (`sub`). Must not throw. */
  onActive: (tenantId: string, userId: string) => void | Promise<void>;
}

/**
 * The user (`sub`) of a JWT access token, or `undefined` (not a JWT, no
 * subject, or a client-only token whose `sub` is its `client_id`).
 */
export function subjectOf(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const sub = propertyOf(claims, "sub");
    const clientId = propertyOf(claims, "client_id");
    if (typeof sub !== "string" || sub === "") return undefined;
    // A client_credentials token carries its client as `sub`: no user.
    return sub === clientId ? undefined : sub;
  } catch {
    return undefined;
  }
}

/**
 * Wraps the issuers' `handle`: `/authorize`, `/par`, `/device_authorization`, `/register` and `/token` (refresh and device
 * codes included)
 * of a suspended or deleted tenant answer 403 `TENANT_SUSPENDED`; discovery,
 * JWKS, userinfo, introspection and revocation answer as before. A token
 * issued on `/token` counts its user as active this month.
 */
export function withTenantState<
  T extends {
    handle: (request: Request, ip?: string | undefined) => Promise<Response>;
  },
>(oauth: T, { resolver, onActive }: TenantStateOptions): T {
  return {
    ...oauth,
    handle: async (request: Request, ip?: string | undefined) => {
      const path = new URL(request.url).pathname;
      if (!REFUSED_PATHS.has(path)) return oauth.handle(request, ip);
      const tenant = await resolver.resolveRequest(request);
      if (tenant !== null && !isLive(tenant)) {
        return suspendedResponse();
      }
      const response = await oauth.handle(request, ip);
      if (
        path === "/token" &&
        response.ok &&
        tenant !== null &&
        onActive !== undefined
      ) {
        const body: unknown = await response
          .clone()
          .json()
          .catch(() => null);
        const user = subjectOf(propertyOf(body, "access_token"));
        if (user !== undefined) await onActive(tenant.tenantId, user);
      }
      return response;
    },
  };
}
