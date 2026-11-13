import { createHash, timingSafeEqual } from "node:crypto";
import { normalizeHost } from "@/tenancy/host";
import { normalizeDomainHost } from "./domain-host";

/** The path Caddy's `on_demand_tls { ask }` calls. */
export const TLS_ASK_PATH = "/internal/tls/ask";

export interface TlsAskDeps {
  /** `CLAVIX_TLS_ASK_SECRET`; `undefined`: the endpoint answers 404 to everyone. */
  secret: string | undefined;
  platformDomain: string;
  /** Whether a certificate may be issued for a custom host: a verified domain of a live tenant. */
  allowed(host: string): Promise<boolean>;
  /**
   * Whether a certificate may be issued for a host under the platform domain
   * (`<slug>.<platformDomain>` of a live tenant, `console.`, the apex). Unset:
   * none is, only custom domains are served.
   */
  allowedPlatformHost?: ((host: string) => Promise<boolean>) | undefined;
  /** Spends one ask; `false` past the limit. Redis down: `true` (logged by the implementation). */
  limit?: (() => Promise<boolean>) | undefined;
  log?: (message: string) => void;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

const answer = (status: number) =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

/**
 * Caddy's on-demand TLS ask: 200 for a verified custom domain of a live
 * tenant or for a known platform host (a live tenant's slug host), 404 for
 * everything else, 429 past the rate limit. It reveals
 * nothing: a wrong secret, a missing or malformed domain, an unknown, pending,
 * lapsed or suspended one all answer the same bare 404. A request that went
 * through a proxy (it carries `X-Forwarded-*`) is public traffic and is
 * refused too: Caddy calls this URL itself.
 */
export function tlsAsk(deps: TlsAskDeps) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" || deps.secret === undefined) {
      return answer(404);
    }
    const forwarded =
      request.headers.has("x-forwarded-for") ||
      request.headers.has("x-forwarded-host") ||
      request.headers.has("forwarded");
    if (forwarded) return answer(404);
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    if (!timingSafeEqual(digest(token), digest(deps.secret))) {
      return answer(404);
    }
    if (deps.limit !== undefined && !(await deps.limit())) return answer(429);
    const raw = url.searchParams.get("domain") ?? "";
    const platformHost = normalizeHost(raw);
    const platform = deps.platformDomain.toLowerCase();
    const underPlatform =
      platformHost !== null &&
      (platformHost === platform || platformHost.endsWith(`.${platform}`));
    let host: string;
    if (underPlatform) {
      host = platformHost;
    } else {
      try {
        host = normalizeDomainHost(raw, deps.platformDomain);
      } catch {
        return answer(404);
      }
    }
    try {
      const ok = underPlatform
        ? ((await deps.allowedPlatformHost?.(host)) ?? false)
        : await deps.allowed(host);
      return answer(ok ? 200 : 404);
    } catch (error) {
      (deps.log ?? console.warn)(`tls-ask: lookup failed: ${String(error)}`);
      return answer(404);
    }
  };
}
