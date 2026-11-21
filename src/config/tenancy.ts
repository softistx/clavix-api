import type { TypedCollection } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { PublicOrigin, tenants } from "@/modules/tenants";
import { hostOf, TenantsService } from "@/modules/tenants";
import { createTenantResolver, type DomainDirectory } from "@/tenancy/resolver";
import {
  noTenantCache,
  redisTenantCache,
  type TenantCache,
} from "@/tenancy/tenant-cache";
import { linkTenantToPlatform } from "./access";
import { mongo } from "./db";
import { createDomainsService } from "./domains";
import { env } from "./env";
import { keysService } from "./keys";
import { redis } from "./redis";
import { clock, warn } from "./runtime";

export interface TenancyOptions {
  tenants: TypedCollection<typeof tenants>;
  cache: TenantCache;
  config: PublicOrigin;
  /** The custom domains hosts resolve through (A4). */
  domains: DomainDirectory;
  /** A tenant's verified custom hosts, dropped from the cache with its slug host on each tenant write. */
  hostsOf: (tenantId: ObjectId) => Promise<string[]>;
  /** Gives a new tenant its first signing key. */
  onCreated: (tenantId: string) => void | Promise<void>;
  /** Where a hook failure is logged. */
  log: (message: string) => void;
}

/**
 * The tenancy wiring: the resolver reads the tenants collection through the
 * cache, and every tenant write drops the hosts it touched from that cache.
 */
export function createTenancy({
  tenants,
  cache,
  config,
  domains,
  hostsOf,
  onCreated,
  log,
}: TenancyOptions) {
  const tenantResolver = createTenantResolver({
    // The trash included: a deleted tenant answers as a suspended one does.
    lookup: (slug) => tenants.findFirst({ slug }, { withDeleted: true }),
    cache,
    config,
    log,
    domains,
    lookupById: (id) => tenants.findById(id, { withDeleted: true }),
  });
  const tenantsService = new TenantsService(tenants, {
    domain: config.domain,
    onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
    log,
    now: clock,
    hostsOf,
    onCreated,
  });
  return { tenantResolver, tenantsService };
}

// The cache behind the resolver: Redis when REDIS_URL is set, none otherwise.
// The domain store and the resolver refer to each other (a domain write drops
// hosts from the cache; a custom host resolves through the store): the
// closures below are called only after both exist.
/** The tenants' parent domain, read once from the environment. */
export const tenantDomain = env.CLAVIX_DOMAIN;

/** Where a tenant's issuer lives: scheme, parent domain and port, read once from the environment. */
export const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: tenantDomain,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;

export const domainsService = createDomainsService({
  onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
  slugHostOf: async (tenantId) => {
    const tenant = await tenantsService.find(tenantId);
    return tenant === undefined
      ? undefined
      : hostOf(tenant.slug, env.CLAVIX_DOMAIN);
  },
});

export const { tenantResolver, tenantsService } = createTenancy({
  tenants: mongo.db.tenants,
  // The first signing key, and the platform link (the console's permissions).
  onCreated: async (tenantId) => {
    // The link first: cheap and idempotent, so a failing key never leaves a tenant unseen by operators.
    await linkTenantToPlatform(tenantId);
    await keysService.ensureSigningKey(tenantId);
  },
  cache:
    redis === undefined
      ? noTenantCache
      : redisTenantCache(redis.cache.tenantHost),
  domains: {
    tenantOfHost: (host) => domainsService.tenantOfHost(host),
    primaryHostOf: (tenantId) => domainsService.primaryHostOf(tenantId),
    verifiedHostsOf: (tenantId) => domainsService.verifiedHostsOf(tenantId),
  },
  hostsOf: (tenantId) => domainsService.resolvingHostsOf(tenantId),
  config: origin,
  log: warn,
});

/** A stored tenant by slug (suspended ones included), for the operator scripts. */
export const tenantBySlug = (slug: string) =>
  mongo.db.tenants.findFirst({ slug });

/** The tenants collection, for the operator scripts (this module is the wiring allowed to reach it). */
export const tenantsCollection = mongo.db.tenants;
