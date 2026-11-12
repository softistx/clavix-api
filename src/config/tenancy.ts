import { TenantsService } from "@/modules/tenants";
import { createTenantResolver } from "@/tenancy/resolver";
import {
  noTenantCache,
  redisTenantCache,
  type TenantCache,
} from "@/tenancy/tenant-cache";
import { mongo } from "./db";
import { env } from "./env";
import { redis } from "./redis";

// The cache behind the resolver: Redis when REDIS_URL is set, none otherwise.
const cache: TenantCache =
  redis === undefined
    ? noTenantCache
    : redisTenantCache(redis.cache.tenantHost);

export const tenantResolver = createTenantResolver({
  lookup: (slug) => mongo.db.tenants.findFirst({ slug }),
  cache,
  config: {
    scheme: env.CLAVIX_PUBLIC_SCHEME,
    domain: env.CLAVIX_DOMAIN,
    port: env.CLAVIX_PUBLIC_PORT,
  },
});

// Every tenant write drops the hosts it touched from the cache.
export const tenantsService = new TenantsService(mongo.db.tenants, {
  onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
});
