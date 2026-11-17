import type { OAuthIssuers } from "@softistx/janus-oauth";
import { isLive, TENANT_SUSPENDED } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";

/** The paths that open or extend a session; the others keep answering for a suspended tenant (ADR-0039). */
const REFUSED_PATHS = new Set([
  "/authorize",
  "/par",
  "/device_authorization",
  "/token",
]);

export interface TenantStateOptions {
  resolver: Pick<TenantResolver, "resolveRequest">;
  /** Called after a token was issued or refreshed, with the tenant and the user (`sub`). Must not throw. */
  onActive?: (tenantId: string, userId: string) => void | Promise<void>;
}

/** The `sub` of a JWT, or `undefined` (not a JWT, no subject). */
export function subjectOf(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const sub = (claims as { sub?: unknown } | null)?.sub;
    return typeof sub === "string" && sub !== "" ? sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wraps the issuers' `handle`: `/authorize`, `/par`, `/device_authorization` and `/token` (refresh and device
 * codes included)
 * of a suspended or deleted tenant answer 403 `TENANT_SUSPENDED`; discovery,
 * JWKS, userinfo, introspection and revocation answer as before. A token
 * issued on `/token` counts its user as active this month.
 */
export function withTenantState<T extends Pick<OAuthIssuers, "handle">>(
  oauth: T,
  { resolver, onActive }: TenantStateOptions,
): T {
  return {
    ...oauth,
    handle: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (!REFUSED_PATHS.has(path)) return oauth.handle(request);
      const tenant = await resolver.resolveRequest(request);
      if (tenant !== null && !isLive(tenant)) {
        return Response.json(
          {
            error: "access_denied",
            error_description: "This service is suspended",
            code: TENANT_SUSPENDED,
          },
          { status: 403, headers: { "cache-control": "no-store" } },
        );
      }
      const response = await oauth.handle(request);
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
        const user = subjectOf(
          (body as { access_token?: unknown } | null)?.access_token,
        );
        if (user !== undefined) await onActive(tenant.tenantId, user);
      }
      return response;
    },
  };
}
