import { createHash, timingSafeEqual } from "node:crypto";
import { normalizeHost, slugOfHost } from "@/tenancy/host";
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
  /**
   * Spends one ask of a host that may have a certificate (an unknown host
   * never reaches it); `false` past the limit, and when the limiter cannot
   * answer (fails closed, see `tlsAskGate`).
   */
  limit?: (() => Promise<boolean>) | undefined;
  log?: (message: string) => void;
}

/**
 * The decision for a host under the platform domain: the apex and
 * `console.<domain>` always, `<slug>.<domain>` only when `isLiveTenantHost`
 * says a live tenant has it (never a suspended, deleted or unknown one).
 */
export function platformHostPolicy(options: {
  domain: string;
  isLiveTenantHost(host: string): Promise<boolean>;
}) {
  const domain = options.domain.toLowerCase();
  return async (host: string): Promise<boolean> => {
    if (host === domain || host === `console.${domain}`) return true;
    if (slugOfHost(host, domain) === null) return false;
    return options.isLiveTenantHost(host);
  };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

const answer = (status: number) =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

/**
 * Caddy's on-demand TLS ask: 200 for a verified custom domain of a live
 * tenant or for a known platform host (a live tenant's slug host), 404 for
 * everything else, 429 for a known host past the rate limit (an unknown one
 * is a 404 that spends nothing). It reveals
 * nothing: a wrong secret, a missing or malformed domain, an unknown, pending,
 * lapsed or suspended one all answer the same bare 404. A request that went
 * through a proxy (it carries `X-Forwarded-*`, `X-Real-IP` or `Forwarded`) is public traffic and is
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
      request.headers.has("x-forwarded-proto") ||
      request.headers.has("x-real-ip") ||
      request.headers.has("forwarded");
    if (forwarded) return answer(404);
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    if (!timingSafeEqual(digest(token), digest(deps.secret))) {
      return answer(404);
    }
    const raw = url.searchParams.get("domain") ?? "";
    const platformHost = normalizeHost(raw);
    const platform = deps.platformDomain.toLowerCase();
    const underPlatform =
      platformHost !== null &&
      (platformHost === platform || platformHost.endsWith(`.${platform}`));
    let host: string;
    if (underPlatform) {
      // Cheap shape check: the apex, `console.` or `<slug>.<domain>`.
      if (
        platformHost !== platform &&
        platformHost !== `console.${platform}` &&
        slugOfHost(platformHost, platform) === null
      ) {
        return answer(404);
      }
      host = platformHost;
    } else {
      try {
        host = normalizeDomainHost(raw, deps.platformDomain);
      } catch {
        return answer(404);
      }
    }
    // The host is looked up before the limit is spent: a name nobody serves
    // is refused with the budget untouched, so a flood of unknown names (any
    // client can make the proxy ask) cannot spend what the first handshake of
    // a real host needs. The limit then counts only the asks about to say yes.
    try {
      const ok = underPlatform
        ? ((await deps.allowedPlatformHost?.(host)) ?? false)
        : await deps.allowed(host);
      if (!ok) return answer(404);
    } catch (error) {
      (deps.log ?? console.warn)(`tls-ask: lookup failed: ${String(error)}`);
      return answer(404);
    }
    if (deps.limit !== undefined && !(await deps.limit())) return answer(429);
    return answer(200);
  };
}
