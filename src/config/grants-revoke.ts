import type { OAuthIssuers } from "@softistx/janus-oauth";
import type { RevokeEnqueuer } from "@/modules/consent/revoke-job";
import { issuerOf } from "@/modules/tenants/identity";
import { env } from "./env";
import { redis } from "./redis";
import { tenantsService } from "./tenancy";

/** The queue of the revocations to retry; none without Redis. Replaceable by the specs. */
export const grantsRevokeQueue: { current: RevokeEnqueuer | undefined } = {
  current: redis?.queues.grantsRevoke,
};

/**
 * Revokes every grant of a user over the real stores, outside a request: the
 * tenant's server is found by its issuer URL. A tenant that is gone has no
 * grant left to revoke (its partition is purged).
 */
export const createGrantsRevoke =
  (
    serverFor: OAuthIssuers["serverFor"],
    slugOf: (tenantId: string) => Promise<string | undefined> = async (id) =>
      (await tenantsService.anyById(id))?.slug,
  ) =>
  async ({ tenantId, userId }: { tenantId: string; userId: string }) => {
    const slug = await slugOf(tenantId);
    if (slug === undefined) return 0;
    const issuer = issuerOf(slug, {
      scheme: env.CLAVIX_PUBLIC_SCHEME,
      domain: env.CLAVIX_DOMAIN,
      port: env.CLAVIX_PUBLIC_PORT,
    });
    const server = await serverFor(new Request(`${issuer}/`));
    if (server === null) throw new Error(`grants: no OAuth server for ${slug}`);
    return server.grants.revokeAll({ id: userId });
  };
