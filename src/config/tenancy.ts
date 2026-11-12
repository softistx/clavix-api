import type { TypedCollection } from "@softistx/mongo";
import { TenantsService } from "@/modules/tenants";
import type { PublicOrigin } from "@/modules/tenants/identity";
import type { tenants } from "@/modules/tenants/tenants.model";
import { createTenantResolver } from "@/tenancy/resolver";
import {
  noTenantCache,
  redisTenantCache,
  type TenantCache,
} from "@/tenancy/tenant-cache";
import { mongo } from "./db";
import { env } from "./env";
import { redis } from "./redis";

export interface TenancyOptions {
  tenants: TypedCollection<typeof tenants>;
  cache: TenantCache;
  config: PublicOrigin;
}

/**
 * The tenancy wiring: the resolver reads the tenants collection through the
 * cache, and every tenant write drops the hosts it touched from that cache.
 */
export function createTenancy({ tenants, cache, config }: TenancyOptions) {
  const tenantResolver = createTenantResolver({
    lookup: (slug) => tenants.findFirst({ slug }),
    cache,
    config,
  });
  const tenantsService = new TenantsService(tenants, {
    onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
  });
  return { tenantResolver, tenantsService };
}

// The cache behind the resolver: Redis when REDIS_URL is set, none otherwise.
export const { tenantResolver, tenantsService } = createTenancy({
  tenants: mongo.db.tenants,
  cache:
    redis === undefined
      ? noTenantCache
      : redisTenantCache(redis.cache.tenantHost),
  config: {
    scheme: env.CLAVIX_PUBLIC_SCHEME,
    domain: env.CLAVIX_DOMAIN,
    port: env.CLAVIX_PUBLIC_PORT,
  },
});
