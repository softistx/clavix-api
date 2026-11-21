import {
  ConflictError,
  type IdOf,
  NotFoundError,
  OptimisticLockError,
  type Patch,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { newTenantOAuthPolicy } from "@/modules/oauth-policy/oauth-policy.schema";
import {
  InvalidSlugError,
  PlatformTenantProtectedError,
  SlugTakenError,
  TenantInputError,
} from "./tenants.errors";
import type { Tenant, tenants } from "./tenants.model";
import { type PlanId, QUOTA_KEYS, type QuotaOverrides } from "./tenants.plan";
import { PLATFORM_TENANT_SLUG, slugProblem } from "./tenants.rules";
import { purgeCutoff } from "./tenants.trash";
import type {
  PurgeDeps,
  PurgeReport,
  RegisteredTenant,
  RegisterTenantInput,
  TenantListOptions,
  TenantsServiceOptions,
} from "./tenants.types";
import {
  hostOf,
  listFilterOf,
  listScopeOf,
  objectIdsOf,
  partitionOf,
  reasonOf,
  registeredOf,
  stateOf,
} from "./tenants.utils";

type TenantId = IdOf<typeof tenants> | string;

/**
 * The platform's tenants, in one service (owner, 2026-11-20): create and
 * register, suspend, reactivate, delete, restore, rename, set the plan and the
 * policies, read (the trash included), list, and the purge. The slug never
 * changes. Every write drops the tenant's hosts from the resolver's cache.
 */
export class TenantsService {
  private readonly domain: string;
  private readonly onHostsChanged: (hosts: string[]) => void | Promise<void>;
  private readonly hostsOf: (
    tenantId: ObjectId,
  ) => string[] | Promise<string[]>;
  private readonly onCreated: (tenantId: string) => void | Promise<void>;
  private readonly log: (message: string) => void;
  private readonly now: () => Date;

  constructor(
    private readonly collection: TypedCollection<typeof tenants>,
    options: TenantsServiceOptions,
  ) {
    this.domain = options.domain;
    this.onHostsChanged = options.onHostsChanged;
    this.hostsOf = options.hostsOf;
    this.onCreated = options.onCreated;
    this.log = options.log;
    this.now = options.now;
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
      this.log(`tenants: onCreated failed for ${tenantId}: ${reasonOf(error)}`);
    }
    return created;
  }

  /**
   * Creates a tenant (slug rules, reserved slugs, the first signing key), or
   * reports the one already there. Re-running with the same values changes
   * nothing; a live tenant with other values is refused rather than edited,
   * and a deleted tenant's slug stays reserved.
   */
  async register(input: RegisterTenantInput): Promise<RegisteredTenant> {
    const problem = slugProblem(input.slug);
    if (problem !== undefined) {
      throw new TenantInputError(`invalid slug: ${problem}`);
    }
    const name = input.name.trim();
    if (name === "") throw new TenantInputError("--name must not be empty");
    const existing = await this.collection.findFirst({ slug: input.slug });
    if (existing !== undefined) {
      if (
        existing.name !== name ||
        (input.signUp !== undefined && existing.signUp !== input.signUp)
      ) {
        throw new TenantInputError(
          `the tenant "${input.slug}" already exists (name "${existing.name}", sign-up ${existing.signUp ? "open" : "closed"}); this script does not edit it`,
        );
      }
      return registeredOf(existing, false);
    }
    if ((await this.collection.raw.findOne({ slug: input.slug })) !== null) {
      throw new TenantInputError(
        `the slug "${input.slug}" belongs to a deleted tenant and stays reserved`,
      );
    }
    try {
      return registeredOf(await this.create({ ...input, name }), true);
    } catch (error) {
      if (
        error instanceof InvalidSlugError ||
        error instanceof SlugTakenError
      ) {
        throw new TenantInputError(error.message);
      }
      throw error;
    }
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
    const valid = objectIdsOf(ids);
    if (valid.length === 0) return [];
    return this.collection.findMany({
      filter: { _id: { $in: valid }, status: "active" },
    });
  }

  /**
   * The tenants with these ids (hex) that are active or suspended (ADR-0039:
   * the console stays readable on a suspended one); an unknown or trashed one
   * is left out.
   */
  async liveByIds(ids: readonly string[]): Promise<Tenant[]> {
    const valid = objectIdsOf(ids);
    if (valid.length === 0) return [];
    return this.collection.findMany({
      filter: { _id: { $in: valid }, status: { $in: ["active", "suspended"] } },
    });
  }

  /** The tenants with these ids (hex) that are not in the trash, suspended ones included. */
  async visibleByIds(ids: readonly string[]): Promise<Tenant[]> {
    const valid = objectIdsOf(ids);
    if (valid.length === 0) return [];
    return this.collection.findMany({ filter: { _id: { $in: valid } } });
  }

  /** The tenant whatever its state (suspended, in the trash, a purge's tombstone), or `undefined`. */
  async anyById(id: string): Promise<Tenant | undefined> {
    if (!ObjectId.isValid(id)) return undefined;
    return this.collection.findById(id, { withDeleted: true });
  }

  /** The tenant with this id (hex), in the trash or not; `undefined` when unknown or being purged. */
  async find(id: string): Promise<Tenant | undefined> {
    if (!ObjectId.isValid(id)) return undefined;
    const tenant = await this.collection.findById(id, { withDeleted: true });
    return tenant === undefined || stateOf(tenant) === null
      ? undefined
      : tenant;
  }

  /** As `find`; an unknown tenant is a `NotFoundError`. */
  async get(id: string): Promise<Tenant> {
    const tenant = await this.find(id);
    if (tenant === undefined)
      throw new NotFoundError(`No tenant ${id}`, { collection: "tenants", id });
    return tenant;
  }

  /** A page of tenants by slug, the trash included, purged ones left out. */
  list(options: TenantListOptions) {
    return this.collection.paginateByCursor({
      filter: listFilterOf(options),
      orderBy: "slug",
      limit: options.first,
      after: options.after,
      withDeleted: true,
      scope: listScopeOf(options),
    });
  }

  /** How many tenants `list` finds with these filters in all; `after` and `first` play no part. */
  count(options: Omit<TenantListOptions, "after" | "first">) {
    return this.collection.count(listFilterOf(options), {
      withDeleted: true,
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
    id: TenantId,
    change: (tenant: Tenant) => Tenant["signIn"] | null,
  ): Promise<Tenant> {
    return this.write(id, 3, (tenant) => {
      const signIn = change(tenant);
      return signIn === null ? null : { signIn };
    });
  }

  /**
   * Changes the tenant's OAuth policy (M3), as `updateSignIn` does: `change`
   * answers the new policy, or `null` for no change (no write, no version
   * bump, so no rebuild); three attempts on a lost race, then the
   * `OptimisticLockError` is thrown.
   */
  updateOAuth(
    id: TenantId,
    change: (tenant: Tenant) => Tenant["oauth"] | null,
  ): Promise<Tenant> {
    return this.write(id, 3, (tenant) => {
      const oauth = change(tenant);
      return oauth === null ? null : { oauth };
    });
  }

  /** Renames the tenant or opens / closes its sign-up. A tenant in the trash is a `NotFoundError`. */
  update(
    id: TenantId,
    input: { name?: string | undefined; signUp?: boolean | undefined },
  ): Promise<Tenant> {
    const name = input.name?.trim();
    if (name === "") throw new TypeError("A tenant needs a name");
    return this.write(id, 2, (tenant) => {
      const patch = {
        ...(name === undefined || name === tenant.name ? {} : { name }),
        ...(input.signUp === undefined || input.signUp === tenant.signUp
          ? {}
          : { signUp: input.signUp }),
      };
      return Object.keys(patch).length === 0 ? null : patch;
    });
  }

  /** Sets the plan and replaces the overrides. A tenant in the trash is a `NotFoundError`. */
  setPlan(
    id: TenantId,
    input: { plan: PlanId; quotaOverrides: QuotaOverrides },
  ): Promise<Tenant> {
    return this.write(id, 2, (tenant) => {
      const same =
        tenant.plan === input.plan &&
        QUOTA_KEYS.every(
          (key) => tenant.quotaOverrides[key] === input.quotaOverrides[key],
        );
      return same
        ? null
        : { plan: input.plan, quotaOverrides: input.quotaOverrides };
    });
  }

  suspend(id: TenantId): Promise<Tenant> {
    return this.setStatus(id, "suspended");
  }

  reactivate(id: TenantId): Promise<Tenant> {
    return this.setStatus(id, "active");
  }

  /** Archives the tenant (soft delete); its slug stays reserved. */
  async delete(id: TenantId): Promise<Tenant> {
    const tenant = await this.collection.getById(id);
    this.refuseIfPlatform(tenant, "deleted");
    const deleted = await this.collection.delete(tenant._id);
    await this.changed(deleted);
    return deleted;
  }

  /** Puts the tenant in the trash; a tenant already there is returned as it is. */
  async trash(id: string): Promise<Tenant> {
    const tenant = await this.get(id);
    return tenant.deletedAt === null ? this.delete(tenant._id) : tenant;
  }

  /**
   * Takes the tenant out of the trash, with the status it had. A live tenant
   * is returned as it is; one the purge has claimed is a `NotFoundError`.
   */
  async restore(id: string): Promise<Tenant> {
    const tenant = await this.get(id);
    if (tenant.deletedAt === null) return tenant;
    // One atomic step against the purge's claim: a tenant is never restored
    // while its data is being removed.
    const result = await this.collection.raw.updateOne(
      {
        _id: tenant._id,
        deletedAt: { $ne: null },
        purgeStartedAt: { $exists: false },
      },
      {
        $set: { deletedAt: null, updatedAt: this.now() },
        $inc: { version: 1 },
      },
    );
    if (result.matchedCount === 0) return this.restore(id);
    const restored = await this.collection.getById(tenant._id);
    await this.changed(restored);
    return restored;
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
        $set: { "signIn.social": social, updatedAt: this.now() },
        $inc: { version: 1 },
      },
    );
    if (result.matchedCount === 0) return false;
    await this.changed(tenant);
    return true;
  }

  /** The tenants whose 30 days are over at `now`, a purge left unfinished included. */
  purgeDue(now: Date): Promise<Tenant[]> {
    return this.collection.findMany({
      filter: {
        deletedAt: { $lte: purgeCutoff(now) },
        purgedAt: { $exists: false },
      },
      withDeleted: true,
    });
  }

  /**
   * Claims the tenant for the purge: from here it resolves nowhere and cannot
   * be restored. `false` when it is not in the trash, not due at `now`, or
   * already purged; claiming again an unfinished purge is `true` (a resume).
   */
  async claimPurge(tenant: Tenant, now: Date): Promise<boolean> {
    const result = await this.collection.raw.updateOne(
      {
        _id: tenant._id,
        deletedAt: { $ne: null, $lte: purgeCutoff(now) },
        purgedAt: { $exists: false },
      },
      { $set: { purgeStartedAt: now }, $inc: { version: 1 } },
    );
    if (result.matchedCount === 0) return false;
    await this.changed(tenant);
    return true;
  }

  /**
   * Ends a purge: what stays is the tombstone (the slug, `deletedAt`,
   * `purgedAt`), which keeps the slug reserved for ever through the unique
   * index. The name goes with the data.
   */
  async markPurged(tenant: Tenant, now: Date): Promise<void> {
    await this.collection.raw.updateOne(
      { _id: tenant._id, purgeStartedAt: { $exists: true } },
      {
        $set: { purgedAt: now, name: "", signUp: false, quotaOverrides: {} },
        $inc: { version: 1 },
      },
    );
  }

  /**
   * Purges the tenants whose 30 days of trash are over at `now`. Each tenant:
   * claimed (it resolves nowhere and cannot be restored from then on), its
   * partition, its tenant-owned collections and its memberships removed, then
   * the tombstone (`slug`, `deletedAt`, `purgedAt`) keeps the slug reserved. A
   * tenant that fails is left claimed and resumed by the next run; the others
   * go on. Refuses a tenant before its `purgeAt` (`claimPurge` says no).
   */
  async purge(deps: PurgeDeps, now: Date): Promise<PurgeReport> {
    const log = deps.log;
    const report: PurgeReport = { purged: [], failed: [] };
    for (const tenant of await this.purgeDue(now)) {
      const id = tenant._id.toHexString();
      try {
        if (!(await this.claimPurge(tenant, now))) continue;
        const counts = await deps.partitions.purgePartition(id);
        log(
          `tenants: purged the partition of ${id}: ${JSON.stringify(counts)}`,
        );
        for (const owned of deps.owned) await owned.deleteOwnedBy(tenant._id);
        await deps.memberships.removeTenant(id);
        await this.markPurged(tenant, now);
        report.purged.push(id);
      } catch (error) {
        report.failed.push(id);
        log(
          `tenants: purge of ${id} stopped, the next run resumes it: ${reasonOf(error)}`,
        );
      }
    }
    return report;
  }

  // The version read is the version expected: a write that raced ours is not
  // overwritten. On a lost race the tenant is read again; the last attempt's
  // `OptimisticLockError` is the caller's. `patch` answers `null` when nothing
  // changes (no write, no version bump), and may refuse by throwing.
  private async write(
    id: TenantId,
    attempts: number,
    patch: (tenant: Tenant) => Patch<typeof tenants> | null,
  ): Promise<Tenant> {
    for (let attempt = 1; ; attempt++) {
      const tenant = await this.collection.getById(id);
      const changes = patch(tenant);
      if (changes === null) return tenant;
      try {
        const updated = await this.collection.update(tenant._id, {
          ...changes,
          version: tenant.version,
        });
        await this.changed(updated);
        return updated;
      } catch (error) {
        if (!(error instanceof OptimisticLockError) || attempt === attempts) {
          throw error;
        }
      }
    }
  }

  private setStatus(id: TenantId, status: Tenant["status"]): Promise<Tenant> {
    return this.write(id, 2, (tenant) => {
      if (status === "suspended") this.refuseIfPlatform(tenant, "suspended");
      return tenant.status === status ? null : { status };
    });
  }

  private refuseIfPlatform(tenant: Tenant, what: string) {
    if (tenant.slug === PLATFORM_TENANT_SLUG) {
      throw new PlatformTenantProtectedError(
        `The platform tenant "${PLATFORM_TENANT_SLUG}" cannot be ${what}`,
      );
    }
  }

  /**
   * After a tenant write: drops the tenant's slug host and its custom hosts
   * from the resolver's cache. Errors are logged and swallowed, the write
   * stands.
   */
  private async changed(tenant: Pick<Tenant, "slug" | "_id">): Promise<void> {
    const hosts = [hostOf(tenant.slug, this.domain)];
    try {
      hosts.push(...(await this.hostsOf(tenant._id)));
    } catch (error) {
      this.log(`tenants: hostsOf failed for ${hosts[0]}: ${reasonOf(error)}`);
    }
    try {
      await this.onHostsChanged(hosts);
    } catch (error) {
      this.log(
        `tenants: onHostsChanged failed for ${hosts.join(", ")}: ${reasonOf(error)}`,
      );
    }
  }
}
