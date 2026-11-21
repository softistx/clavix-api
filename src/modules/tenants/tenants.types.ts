import type { ObjectId } from "mongodb";
import type { Tenant } from "./tenants.model";

/** Where tenants' issuers live: from `CLAVIX_DOMAIN` and the public scheme/port. */
export interface PublicOrigin {
  scheme: "https" | "http";
  domain: string;
  port?: number | undefined;
}

export interface TenantsServiceOptions {
  /** The apex tenants' hosts hang under. Default `CLAVIX_DOMAIN`. */
  domain?: string;
  /**
   * Called with the hosts whose resolution may have changed, after the write
   * (the resolver's cache drops them from step 3 of slice 1.1). Default: none.
   * Contract: it runs after the write is stored; an error it throws is logged
   * (`log`) and swallowed, never reaching the caller, so the write stands. A
   * cache that failed to drop a host heals by its TTL.
   */
  onHostsChanged?: (hosts: string[]) => void | Promise<void>;
  /**
   * Every custom host that resolves to the tenant (verified, or a lapsed primary), dropped with its slug host on each
   * write: a suspended or deleted tenant must stop resolving on them at once.
   * Default: none. An error is logged and the slug host is still dropped.
   */
  hostsOf?: (tenantId: ObjectId) => string[] | Promise<string[]>;
  /**
   * Called with the tenant's id (hex, the janus partition) once it is created,
   * to give it its first signing key before any token. Same contract as
   * `onHostsChanged`: an error is logged and swallowed, the tenant stands, and
   * the rotation job creates the key within the hour.
   */
  onCreated?: (tenantId: string) => void | Promise<void>;
  /** Where a hook failure is logged. Default `console.warn`. */
  log?: (message: string) => void;
}

/** Where a tenant stands for the console: `deleted` is the trash. */
export type TenantState = "active" | "suspended" | "deleted";

/** What `list` filters on: a state, or `live` for every tenant not in the trash. */
export type TenantListState = TenantState | "live";

export interface TenantListOptions {
  /** The start of a slug or a part of a name. */
  q?: string | undefined;
  state?: TenantListState | undefined;
  /** Only these tenants (hex ids); an empty list matches none. */
  ids?: readonly string[] | undefined;
  after?: string | undefined;
  first: number;
}

export interface RegisterTenantInput {
  slug: string;
  name: string;
  /** Open sign-up for unknown e-mails. Default: closed (invitation only). */
  signUp?: boolean;
}

export interface RegisteredTenant {
  /** `false` when the tenant already existed with these values: nothing was written. */
  created: boolean;
  /** The tenant's id in hex: its partition everywhere. */
  tenantId: string;
  slug: string;
  name: string;
  status: Tenant["status"];
  signUp: boolean;
}

/** Documents removed per collection, as the janus purges count them. */
export type PartitionPurgeCounts = Record<string, number>;

/**
 * Removes what a tenant's janus partition holds: users, sessions, passkeys,
 * invitations, OAuth clients, grants and tokens, and the signing keys
 * (`src/config/partition-purger.ts`). Resumable (a second call removes what
 * the first left) and idempotent; answers the counts per collection.
 */
export interface PartitionPurger {
  purgePartition(partition: string): Promise<PartitionPurgeCounts>;
}

/** One tenant-owned collection of the app, reached through the tenancy helpers (`tenantOwned`). */
export interface OwnedCollectionPurger {
  name: string;
  /** Removes every document the tenant owns; the number removed. */
  deleteOwnedBy(tenantId: ObjectId): Promise<number>;
}

export interface PurgeDeps {
  /** The app's tenant-owned collections: `tenantOwned(collections)`, never a platform one (`adminEvents` stays). */
  owned: readonly OwnedCollectionPurger[];
  /** The tenant's roles and platform link in the console's permissions. */
  memberships: { removeTenant(tenantId: string): Promise<unknown> };
  partitions: PartitionPurger;
  log?: (message: string) => void;
}

export interface PurgeReport {
  /** Hex ids of the tenants whose purge ended. */
  purged: string[];
  /** Hex ids of the tenants whose purge stopped on an error; the next run resumes them. */
  failed: string[];
}
