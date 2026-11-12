import type { ObjectId } from "mongodb";
import {
  issuerOf,
  type PublicOrigin,
  partitionOf,
} from "@/modules/tenants/identity";
import { hostOfRequest, normalizeHost, slugOfHost } from "./host";
import type { ResolvedTenant } from "./resolved-tenant";
import type { TenantCache } from "./tenant-cache";

/** What the resolver needs of a stored tenant. */
export interface TenantRecord {
  _id: ObjectId;
  slug: string;
  status: "active" | "suspended";
  version: number;
}

export interface TenantResolverOptions {
  /** The live tenant with this slug, or `undefined` (a deleted one is none). */
  lookup: (slug: string) => Promise<TenantRecord | undefined>;
  cache: TenantCache;
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

/**
 * Host to tenant: `<slug>.<CLAVIX_DOMAIN>` with an active tenant of that slug.
 * Only hosts of a valid slug shape reach the cache or Mongo, so arbitrary
 * hosts cannot fill either. A cache failure is logged and Mongo is read.
 */
export function createTenantResolver(
  options: TenantResolverOptions,
): TenantResolver {
  const { lookup, cache, config } = options;
  const log = options.log ?? ((message) => console.warn(message));
  const hitTtl = options.hitTtl ?? 60;
  const missTtl = options.missTtl ?? 30;

  const attempt = async <T>(
    what: string,
    host: string,
    run: () => T | Promise<T>,
  ) => {
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
  };

  const toResolved = (tenant: TenantRecord | undefined) =>
    tenant === undefined || tenant.status !== "active"
      ? null
      : ({
          tenantId: tenant._id.toHexString(),
          slug: tenant.slug,
          issuer: issuerOf(tenant.slug, config),
          partition: partitionOf(tenant._id),
          version: tenant.version,
        } satisfies ResolvedTenant);

  const resolveHost = async (raw: string) => {
    const host = normalizeHost(raw);
    if (host === null) return null;
    const slug = slugOfHost(host, config.domain);
    if (slug === null) return null;

    const cached = await attempt("read", host, () => cache.get(host));
    if (cached !== undefined) return cached;

    const resolved = toResolved(await lookup(slug));
    await attempt("write", host, () =>
      cache.set(host, resolved, resolved === null ? missTtl : hitTtl),
    );
    // Cache-aside race: a write (suspend, delete, create) may have run its
    // invalidation between our read and our `set`, leaving a stale entry. Read
    // the tenant again; if it changed, drop what we just stored.
    const after = toResolved(await lookup(slug));
    if (after?.version !== resolved?.version) {
      await attempt("delete", host, () => cache.delete(host));
    }
    return resolved;
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
