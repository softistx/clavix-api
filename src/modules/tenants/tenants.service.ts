import {
  ConflictError,
  type IdOf,
  OptimisticLockError,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { env } from "@/config/env";
import { newTenantOAuthPolicy } from "@/modules/oauth-policy/oauth-policy.schema";
import { dropTenantHosts } from "./hosts";
import { partitionOf } from "./identity";
import type { PlanId } from "./plan.schema";
import { PLATFORM_TENANT_SLUG, slugProblem } from "./slug";
import {
  InvalidSlugError,
  PlatformTenantProtectedError,
  SlugTakenError,
} from "./tenants.errors";
import type { Tenant, tenants } from "./tenants.model";

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

/** The platform's tenants: create, suspend, reactivate, delete. The slug never changes. */
export class TenantsService {
  private readonly domain: string;
  private readonly onHostsChanged: (hosts: string[]) => void | Promise<void>;
  private readonly hostsOf: (
    tenantId: ObjectId,
  ) => string[] | Promise<string[]>;
  private readonly onCreated: (tenantId: string) => void | Promise<void>;
  private readonly log: (message: string) => void;

  constructor(
    private readonly collection: TypedCollection<typeof tenants>,
    options: TenantsServiceOptions = {},
  ) {
    this.domain = options.domain ?? env.CLAVIX_DOMAIN;
    this.onHostsChanged = options.onHostsChanged ?? (() => {});
    this.hostsOf = options.hostsOf ?? (() => []);
    this.onCreated = options.onCreated ?? (() => {});
    this.log = options.log ?? ((message) => console.warn(message));
  }

  async create(input: {
    slug: string;
    name: string;
    signUp?: boolean;
    plan?: Tenant["plan"];
  }): Promise<Tenant> {
    const problem = slugProblem(input.slug);
    if (problem !== undefined) throw new InvalidSlugError(problem);
    const name = input.name.trim();
    if (name === "") throw new TypeError("A tenant needs a name");
    let created: Tenant;
    try {
      created = await this.collection.create({
        slug: input.slug,
        name,
        // M3 decision 3: pushed authorization requests on for a new tenant.
        // The platform tenant is exempt until the console client pushes.
        ...(input.slug === PLATFORM_TENANT_SLUG
          ? {}
          : { oauth: newTenantOAuthPolicy() }),
        ...(input.signUp === undefined ? {} : { signUp: input.signUp }),
        ...(input.plan === undefined ? {} : { plan: input.plan }),
      });
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new SlugTakenError(`The slug "${input.slug}" is taken`);
      }
      throw error;
    }
    await this.changed(created);
    const tenantId = partitionOf(created._id);
    try {
      await this.onCreated(tenantId);
    } catch (error) {
      this.log(
        `tenants: onCreated failed for ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return created;
  }

  /** The ids (hex, the janus partition) of the active tenants: the ones that sign. */
  async activeIds(): Promise<string[]> {
    const active = await this.collection.findMany({
      filter: { status: "active" },
    });
    return active.map((tenant) => partitionOf(tenant._id));
  }

  /** The ids (hex) of every tenant, the suspended and the trashed included: the partitions that may hold keys. */
  async allIds(): Promise<string[]> {
    const all = await this.collection.findMany({ withDeleted: true });
    return all.map((tenant) => partitionOf(tenant._id));
  }

  /**
   * Every tenant with its plan, the suspended, the trashed and the purged
   * included: their logs follow the plan until the retention ends (D16).
   */
  async retentionTargets(): Promise<{ id: string; plan: PlanId }[]> {
    const all = await this.collection.findMany({ withDeleted: true });
    return all.map((tenant) => ({
      id: partitionOf(tenant._id),
      plan: tenant.plan,
    }));
  }

  /** The active tenants with these ids (hex); an unknown, suspended or deleted one is left out. */
  async activeByIds(ids: readonly string[]): Promise<Tenant[]> {
    const valid = ids.filter((id) => ObjectId.isValid(id));
    if (valid.length === 0) return [];
    return this.collection.findMany({
      filter: {
        _id: { $in: valid.map((id) => new ObjectId(id)) },
        status: "active",
      },
    });
  }

  /**
   * The tenants with these ids (hex) that are active or suspended (ADR-0039:
   * the console stays readable on a suspended one); an unknown or trashed one
   * is left out.
   */
  async liveByIds(ids: readonly string[]): Promise<Tenant[]> {
    const valid = ids.filter((id) => ObjectId.isValid(id));
    if (valid.length === 0) return [];
    return this.collection.findMany({
      filter: {
        _id: { $in: valid.map((id) => new ObjectId(id)) },
        status: { $in: ["active", "suspended"] },
      },
    });
  }

  /**
   * Changes the tenant's sign-in policy (slice A5). `change` gets the stored
   * tenant and answers the new policy, or `null` for no change (no write, no
   * version bump, so no janus rebuild). The version read is the version
   * expected; on a lost race the tenant is read again (three attempts, then
   * the `OptimisticLockError` is thrown).
   */
  updateSignIn(
    id: IdOf<typeof tenants> | string,
    change: (tenant: Tenant) => Tenant["signIn"] | null,
  ): Promise<Tenant> {
    return this.updatePolicy(id, "signIn", change);
  }

  /**
   * Changes the tenant's OAuth policy (M3), as `updateSignIn` does: `change`
   * answers the new policy, or `null` for no change (no write, no version
   * bump, so no rebuild); three attempts on a lost race, then the
   * `OptimisticLockError` is thrown.
   */
  updateOAuth(
    id: IdOf<typeof tenants> | string,
    change: (tenant: Tenant) => Tenant["oauth"] | null,
  ): Promise<Tenant> {
    return this.updatePolicy(id, "oauth", change);
  }

  private async updatePolicy<K extends "signIn" | "oauth">(
    id: IdOf<typeof tenants> | string,
    key: K,
    change: (tenant: Tenant) => Tenant[K] | null,
  ): Promise<Tenant> {
    for (let attempt = 1; ; attempt++) {
      const tenant = await this.collection.getById(id);
      const next = change(tenant);
      if (next === null) return tenant;
      try {
        const updated = await this.collection.update(tenant._id, {
          [key]: next,
          version: tenant.version,
        });
        await this.changed(updated);
        return updated;
      } catch (error) {
        if (!(error instanceof OptimisticLockError) || attempt === 3) {
          throw error;
        }
      }
    }
  }

  /** The tenant whatever its state (suspended, in the trash, a purge's tombstone), or `undefined`. */
  async anyById(id: string): Promise<Tenant | undefined> {
    if (!ObjectId.isValid(id)) return undefined;
    return this.collection.findById(id, { withDeleted: true });
  }

  /**
   * Replaces the social apps of the tenant read as `tenant` (`keys:reseal`:
   * the same apps, their secrets sealed under the new key). The trash is
   * written too, which the typed API refuses, so that a restored tenant still
   * opens its secrets: hence the driver's own write, guarded by the version
   * read. `false` when the tenant changed meanwhile (nothing is written).
   */
  async replaceSocial(
    tenant: Tenant,
    social: Tenant["signIn"]["social"],
  ): Promise<boolean> {
    const result = await this.collection.raw.updateOne(
      { _id: tenant._id, version: tenant.version },
      {
        $set: { "signIn.social": social, updatedAt: new Date() },
        $inc: { version: 1 },
      },
    );
    if (result.matchedCount === 0) return false;
    await this.changed(tenant);
    return true;
  }

  suspend(id: IdOf<typeof tenants> | string): Promise<Tenant> {
    return this.setStatus(id, "suspended");
  }

  reactivate(id: IdOf<typeof tenants> | string): Promise<Tenant> {
    return this.setStatus(id, "active");
  }

  /** Archives the tenant (soft delete); its slug stays reserved. */
  async delete(id: IdOf<typeof tenants> | string): Promise<Tenant> {
    const tenant = await this.collection.getById(id);
    this.refuseIfPlatform(tenant, "deleted");
    const deleted = await this.collection.delete(tenant._id);
    await this.changed(deleted);
    return deleted;
  }

  // The version read is the version expected: a write that raced ours is not
  // overwritten. On a conflict the tenant is read again once; a second
  // conflict is the caller's error.
  private async setStatus(
    id: IdOf<typeof tenants> | string,
    status: Tenant["status"],
  ): Promise<Tenant> {
    for (let attempt = 1; ; attempt++) {
      const tenant = await this.collection.getById(id);
      if (status === "suspended") this.refuseIfPlatform(tenant, "suspended");
      if (tenant.status === status) return tenant;
      try {
        const updated = await this.collection.update(tenant._id, {
          status,
          version: tenant.version,
        });
        await this.changed(updated);
        return updated;
      } catch (error) {
        if (!(error instanceof OptimisticLockError) || attempt === 2) {
          throw error;
        }
      }
    }
  }

  private refuseIfPlatform(tenant: Tenant, what: string) {
    if (tenant.slug === PLATFORM_TENANT_SLUG) {
      throw new PlatformTenantProtectedError(
        `The platform tenant "${PLATFORM_TENANT_SLUG}" cannot be ${what}`,
      );
    }
  }

  private changed(tenant: Tenant) {
    return dropTenantHosts(
      {
        domain: this.domain,
        hostsOf: this.hostsOf,
        onHostsChanged: this.onHostsChanged,
        log: this.log,
      },
      tenant,
    );
  }
}
