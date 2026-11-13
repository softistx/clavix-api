import { ObjectId } from "mongodb";
import { TLS_ASK_PATH, tlsAsk } from "@/modules/domains/tls-ask";
import {
  relatedOrigins,
  WEBAUTHN_WELL_KNOWN,
} from "@/modules/domains/well-known";
import { hostOfRequest, slugOfHost } from "@/tenancy/host";
import { isLive } from "@/tenancy/resolved-tenant";
import { env } from "./env";
import { redis } from "./redis";
import { domainStore, tenantResolver } from "./tenancy";

export { TLS_ASK_PATH, WEBAUTHN_WELL_KNOWN };

/**
 * Caddy's on-demand TLS ask over the real store: a certificate for a host only
 * when it is a verified custom domain of a live tenant.
 */
const askLimits = redis?.limits;

export const serveTlsAsk = tlsAsk({
  secret: env.CLAVIX_TLS_ASK_SECRET,
  platformDomain: env.CLAVIX_DOMAIN,
  allowed: async (host) => {
    if ((await domainStore.verifiedHost(host)) === undefined) return false;
    const tenant = await tenantResolver.resolveHost(host);
    return tenant !== null && isLive(tenant);
  },
  // The platform's own hosts: the apex, the console, and the slug host of a
  // live tenant (never a deleted, suspended or unknown one).
  allowedPlatformHost: async (host) => {
    if (host === env.CLAVIX_DOMAIN || host === `console.${env.CLAVIX_DOMAIN}`) {
      return true;
    }
    if (slugOfHost(host, env.CLAVIX_DOMAIN) === null) return false;
    const tenant = await tenantResolver.resolveHost(host);
    return tenant !== null && isLive(tenant);
  },
  limit:
    askLimits === undefined
      ? undefined
      : async () => {
          try {
            const result = await askLimits.tlsAsk.consume({ scope: "all" }, 1, {
              timeoutMs: 250,
            });
            return result.allowed;
          } catch {
            console.warn("redis unavailable: tls ask limit skipped");
            return true;
          }
        },
});

/** `GET /.well-known/webauthn` on a tenant's slug host: the origins of its verified custom domains (ADR-0036). */
export async function serveWebauthnOrigins(request: Request) {
  if (request.method !== "GET") return new Response(null, { status: 404 });
  const host = hostOfRequest(request);
  const tenant = await tenantResolver.resolveRequest(request);
  if (host === null || tenant === null || !isLive(tenant)) {
    return new Response(null, { status: 404 });
  }
  const slugHost = new URL(tenant.slugIssuer ?? tenant.issuer).hostname;
  if (host !== slugHost) return new Response(null, { status: 404 });
  const hosts = await domainStore.verifiedHostsOf(
    new ObjectId(tenant.tenantId),
  );
  return relatedOrigins(hosts, {
    scheme: env.CLAVIX_PUBLIC_SCHEME,
    port: env.CLAVIX_PUBLIC_PORT,
  });
}
