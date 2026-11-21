import { defineCache } from "@softistx/redis";
import type { ResolvedTenant } from "./resolved-tenant";
import { resolvedTenant } from "./resolved-tenant";

/** A cached answer: the tenant, or `null` (a host known to resolve to none). */
export type CachedTenant = ResolvedTenant | null;

/**
 * Where resolved hosts are kept. `get` gives `undefined` on a miss, `null`
 * for a cached "no tenant". It may throw (Redis down): the resolver logs and
 * reads Mongo.
 */
export interface TenantCache {
  get(host: string): Promise<CachedTenant | undefined>;
  set(
    host: string,
    value: CachedTenant,
    ttlSeconds: number,
  ): void | Promise<void>;
  delete(host: string): void | Promise<void>;
}

/** The Redis cache definition, wired in src/config/redis.ts (`redis.cache.tenantHost`). */
export const tenantHostCache = defineCache({
  name: "tenant-host",
  key: (host: string) => host,
  ttl: 60,
  schema: resolvedTenant.nullable(),
});

/** The structural part of a bound cache this module uses. */
export interface BoundTenantHostCache {
  get(host: string): Promise<CachedTenant | undefined>;
  set(
    host: string,
    value: CachedTenant,
    options?: { ttl?: number },
  ): Promise<void>;
  delete(host: string): Promise<boolean>;
}

/**
 * Redis-backed. Get then set, not `remember`: the resolver decides the TTL
 * (60 s for a tenant, 30 s for none). A value of an older shape reads as a
 * miss (the package forgets it).
 */
export function redisTenantCache(bound: BoundTenantHostCache): TenantCache {
  return {
    get: (host) => bound.get(host),
    set: (host, value, ttlSeconds) =>
      bound.set(host, value, { ttl: ttlSeconds }),
    delete: async (host) => {
      await bound.delete(host);
    },
  };
}

/** In-process, with TTLs: for specs and a single instance without Redis. */
export function memoryTenantCache(
  now: () => number,
): TenantCache & { readonly size: number } {
  const entries = new Map<string, { value: CachedTenant; expires: number }>();
  return {
    get size() {
      return entries.size;
    },
    async get(host) {
      const entry = entries.get(host);
      if (entry === undefined) return undefined;
      if (entry.expires <= now()) {
        entries.delete(host);
        return undefined;
      }
      return entry.value;
    },
    async set(host, value, ttlSeconds) {
      entries.set(host, { value, expires: now() + ttlSeconds * 1000 });
    },
    async delete(host) {
      entries.delete(host);
    },
  };
}

/** Caches nothing: every resolution reads Mongo (no `REDIS_URL` outside production). */
export const noTenantCache: TenantCache = {
  async get() {
    return undefined;
  },
  async set() {},
  async delete() {},
};
