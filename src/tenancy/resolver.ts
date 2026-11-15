import type { ObjectId } from "mongodb";
import {
  issuerOf,
  issuerOfHost,
  type PublicOrigin,
  partitionOf,
} from "@/modules/tenants/identity";
import { hostOfRequest, normalizeHost, slugOfHost } from "./host";
import type { ResolvedTenant } from "./resolved-tenant";
import { noTenantCache, type TenantCache } from "./tenant-cache";

/** What the resolver reads of the custom domains. */
export interface DomainDirectory {
  tenantOfHost(host: string): Promise<ObjectId | undefined>;
  primaryHostOf(tenantId: ObjectId): Promise<string | undefined>;
}

/** What the resolver needs of a stored tenant. */
export interface TenantRecord {
  _id: ObjectId;
  slug: string;
  name: string;
  signUp: boolean;
  status: "active" | "suspended";
  /** Set while the tenant is in the trash. */
  deletedAt?: Date | null | undefined;
  /** Set once the purge claimed the tenant: it resolves nowhere from then on. */
  purgeStartedAt?: Date | undefined;
  version: number;
  signIn: ResolvedTenant["signIn"];
}

export interface TenantResolverOptions {
  /** The stored tenant with this slug, in the trash or not, or `undefined`. */
  lookup: (slug: string) => Promise<TenantRecord | undefined>;
  cache: TenantCache;
  /**
   * Custom domains (A4): the tenant a non-slug host serves and a tenant's
   * primary host. Both are needed to resolve a custom host; the issuer follows
   * the primary host (ADR-0032). Without it only slug hosts resolve.
   */
  domains?: DomainDirectory;
  /** The stored tenant with this id, in the trash or not. Needed with `domains`. */
  lookupById?: (id: ObjectId) => Promise<TenantRecord | undefined>;
  /** Where issuers live (`CLAVIX_DOMAIN`, scheme, port). */
  config: PublicOrigin;
  log?: (message: string) => void;
  /**
   * Seconds a resolved tenant stays cached. Default 60: also the bound on how
   * long a suspension can take to apply when its invalidation was lost.
   */
  hitTtl?: number;
  /** Seconds "no tenant" stays cached. Default 30. */
  missTtl?: number;
}

export interface TenantResolver {
  /** The tenant a host belongs to (any case, with or without a port), or `null`. */
  resolveHost(host: string): Promise<ResolvedTenant | null>;
  /** The tenant a request was addressed to, by its URL's host. */
  resolveRequest(request: Request): Promise<ResolvedTenant | null>;
  /** Forgets the hosts: after a tenant write (`TenantsService.onHostsChanged`). */
  invalidate(hosts: readonly string[]): Promise<void>;
}

function toResolved(
  tenant: TenantRecord | undefined,
  config: PublicOrigin,
  primaryHost?: string,
): ResolvedTenant | null {
  return tenant === undefined || tenant.purgeStartedAt !== undefined
    ? null
    : {
        tenantId: tenant._id.toHexString(),
        slug: tenant.slug,
        name: tenant.name,
        signUp: tenant.signUp,
        status:
          tenant.deletedAt === null || tenant.deletedAt === undefined
            ? tenant.status
            : "deleted",
        issuer:
          primaryHost === undefined
            ? issuerOf(tenant.slug, config)
            : issuerOfHost(primaryHost, config),
        slugIssuer: issuerOf(tenant.slug, config),
        partition: partitionOf(tenant._id),
        version: tenant.version,
        signIn: tenant.signIn,
      };
}

// A cache failure is logged, never thrown: Mongo is read instead.
async function attempt<T>(
  log: (message: string) => void,
  what: string,
  host: string,
  run: () => T | Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    log(
      `tenancy: cache ${what} failed for ${host}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

// The tenant a host belongs to, from the stores: a slug host by its slug, a
// custom host through the domains. `null`: not a host of ours.
async function loadTenant(
  options: TenantResolverOptions,
  host: string,
  slug: string | null,
): Promise<ResolvedTenant | null> {
  let record: TenantRecord | undefined;
  if (slug !== null) {
    record = await options.lookup(slug);
  } else {
    const id = await options.domains?.tenantOfHost(host);
    record = id === undefined ? undefined : await options.lookupById?.(id);
  }
  const primary =
    record === undefined
      ? undefined
      : await options.domains?.primaryHostOf(record._id);
  return toResolved(record, options.config, primary);
}

const stamp = (tenant: ResolvedTenant | null) =>
  tenant === null ? null : [tenant.version, tenant.issuer, tenant.status];

// Cache-aside: read the cache, else load and store, then re-check.
async function resolveCached(
  options: TenantResolverOptions,
  log: (message: string) => void,
  host: string,
  slug: string | null,
): Promise<ResolvedTenant | null> {
  const { cache } = options;
  const hitTtl = options.hitTtl ?? 60;
  const missTtl = options.missTtl ?? 30;
  const cached = await attempt(log, "read", host, () => cache.get(host));
  if (cached !== undefined) return cached;

  const resolved = await loadTenant(options, host, slug);
  // An unknown custom host is not cached: any Host header would fill the cache.
  const keep = slug !== null || resolved !== null;
  if (keep) {
    await attempt(log, "write", host, () =>
      cache.set(host, resolved, resolved === null ? missTtl : hitTtl),
    );
  }
  // Cache-aside race: a write (suspend, delete, create, a domain) may have
  // run its invalidation between our read and our `set`, leaving a stale
  // entry. Read again; if it changed, drop what we just stored.
  // Nothing was stored with `noTenantCache`, so there is nothing to drop.
  if (cache === noTenantCache || !keep) return resolved;
  const after = await loadTenant(options, host, slug);
  if (JSON.stringify(stamp(after)) !== JSON.stringify(stamp(resolved))) {
    await attempt(log, "delete", host, () => cache.delete(host));
  }
  return resolved;
}

/**
 * Host to tenant: `<slug>.<CLAVIX_DOMAIN>` with a tenant of that slug, whatever
 * its status (a purged one is none): the callers that open or extend a session
 * check `isLive`.
 * Only hosts of a valid slug shape reach the cache or Mongo, so arbitrary
 * hosts cannot fill either. A cache failure is logged and Mongo is read.
 */
export function createTenantResolver(
  options: TenantResolverOptions,
): TenantResolver {
  const { cache, config } = options;
  const log = options.log ?? ((message) => console.warn(message));

  const resolveHost = async (raw: string) => {
    const host = normalizeHost(raw);
    if (host === null) return null;
    const slug = slugOfHost(host, config.domain);
    // Only hosts of a valid slug shape (or, with custom domains, any other
    // host, read from the domains by an indexed lookup) reach Mongo.
    if (slug === null && options.domains === undefined) return null;
    // Under the platform apex but not a valid slug: never a custom domain.
    if (slug === null && host.endsWith(`.${config.domain}`)) return null;
    if (slug === null && host === config.domain) return null;
    return resolveCached(options, log, host, slug);
  };

  return {
    resolveHost,
    async resolveRequest(request) {
      const host = hostOfRequest(request);
      return host === null ? null : resolveHost(host);
    },
    async invalidate(hosts) {
      await Promise.all(
        hosts.map(async (raw) => {
          const host = normalizeHost(raw) ?? raw;
          // Retried once: a suspension must not outlive a blip of Redis. If
          // the retry fails too, the caller logs it and the entry expires
          // within `hitTtl` (60 s) at worst.
          try {
            await cache.delete(host);
          } catch {
            await cache.delete(host);
          }
        }),
      );
    },
  };
}
