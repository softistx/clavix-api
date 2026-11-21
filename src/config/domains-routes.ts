import { ObjectId } from "mongodb";
import {
  platformHostPolicy,
  relatedOrigins,
  TLS_ASK_PATH,
  tlsAsk,
  WEBAUTHN_WELL_KNOWN,
} from "@/modules/domains";
import { tlsAskGate } from "@/modules/domains/domains.tls-limit";
import { hostOfRequest } from "@/tenancy/host";
import { isLive } from "@/tenancy/resolved-tenant";
import { env } from "./env";
import { redis } from "./redis";
import { domainsService, tenantResolver } from "./tenancy";

export { TLS_ASK_PATH, WEBAUTHN_WELL_KNOWN };

/**
 * Caddy's on-demand TLS ask over the real store: a certificate for a host only
 * when it is a verified custom domain of a live tenant.
 */
const askLimits = redis?.limits;

/** The ask over the real stores, with the given secret (specs pass their own). */
export const tlsAskOver = (secret: string | undefined) =>
  tlsAsk({
    secret,
    platformDomain: env.CLAVIX_DOMAIN,
    allowed: async (host) => {
      if ((await domainsService.verifiedHost(host)) === undefined) return false;
      const tenant = await tenantResolver.resolveHost(host);
      return tenant !== null && isLive(tenant);
    },
    // The platform's own hosts: the apex, the console, and the slug host of a
    // live tenant (never a deleted, suspended or unknown one).
    allowedPlatformHost: platformHostPolicy({
      domain: env.CLAVIX_DOMAIN,
      isLiveTenantHost: async (host) => {
        const tenant = await tenantResolver.resolveHost(host);
        return tenant !== null && isLive(tenant);
      },
    }),
    // Fails closed when Redis is down (`tlsAskGate`); no Redis at all
    // (development, specs): no limit.
    limit:
      askLimits === undefined
        ? undefined
        : tlsAskGate(() =>
            askLimits.tlsAsk.consume({ scope: "all" }, 1, { timeoutMs: 250 }),
          ),
  });

export const serveTlsAsk = tlsAskOver(env.CLAVIX_TLS_ASK_SECRET);

/** `GET /.well-known/webauthn` on a tenant's slug host: the origins of its verified custom domains (ADR-0036). */
export async function serveWebauthnOrigins(request: Request) {
  if (request.method !== "GET") return new Response(null, { status: 404 });
  const host = hostOfRequest(request);
  const tenant = await tenantResolver.resolveRequest(request);
  if (host === null || tenant === null || !isLive(tenant)) {
    return new Response(null, { status: 404 });
  }
  const slugHost = new URL(tenant.slugIssuer).hostname;
  if (host !== slugHost) return new Response(null, { status: 404 });
  const hosts = await domainsService.verifiedHostsOf(
    new ObjectId(tenant.tenantId),
  );
  return relatedOrigins(hosts, {
    scheme: env.CLAVIX_PUBLIC_SCHEME,
    port: env.CLAVIX_PUBLIC_PORT,
  });
}
