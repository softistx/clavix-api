import {
  type IdOf,
  NotFoundError,
  OptimisticLockError,
  type Patch,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { env } from "@/config/env";
import { dropTenantHosts } from "./hosts";
import type { PlanId, QuotaOverrides } from "./plan.schema";
import type { Tenant, tenants } from "./tenants.model";
import type { TenantsService } from "./tenants.service";
import { purgeCutoff } from "./trash.schema";

/** Where a tenant stands for the console: `deleted` is the trash. */
export type TenantState = "active" | "suspended" | "deleted";

/** A stored tenant's state; `null` once its purge started (it is gone for everyone). */
export const stateOf = (tenant: {
  status: Tenant["status"];
  deletedAt: Date | null;
  purgeStartedAt?: Date | undefined;
}): TenantState | null => {
  if (tenant.purgeStartedAt !== undefined) return null;
  return tenant.deletedAt === null ? tenant.status : "deleted";
};

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

export interface TenantAdminOptions {
  /** The apex tenants' hosts hang under. Default `CLAVIX_DOMAIN`. */
  domain?: string;
  /** As `TenantsServiceOptions.onHostsChanged`: after the write, errors logged and swallowed. */
  onHostsChanged?: (hosts: string[]) => void | Promise<void>;
  /**
   * Every custom host that resolves to the tenant (verified, or a lapsed primary), dropped with its slug host on each
   * write: a suspended or deleted tenant must stop resolving on them at once.
   * Default: none. An error is logged and the slug host is still dropped.
   */
  hostsOf?: (tenantId: ObjectId) => string[] | Promise<string[]>;
  log?: (message: string) => void;
}

const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const STATE_FILTER = {
  active: { status: "active", deletedAt: null },
  suspended: { status: "suspended", deletedAt: null },
  deleted: { deletedAt: { $ne: null } },
  live: { deletedAt: null },
} as const;

/**
 * What the console's platform operators do to tenants beyond
 * `TenantsService`: read (the trash included), list, rename, set the plan,
 * delete and restore, and the three writes of the purge. Every write drops
 * the tenant's host from the resolver's cache, as the service's do.
 */
export class TenantAdminService {
  private readonly domain: string;
  private readonly onHostsChanged: (hosts: string[]) => void | Promise<void>;
  private readonly hostsOf: (
    tenantId: ObjectId,
  ) => string[] | Promise<string[]>;
  private readonly log: (message: string) => void;

  constructor(
    private readonly collection: TypedCollection<typeof tenants>,
    private readonly service: Pick<TenantsService, "delete">,
    options: TenantAdminOptions = {},
  ) {
    this.domain = options.domain ?? env.CLAVIX_DOMAIN;
    this.onHostsChanged = options.onHostsChanged ?? (() => {});
    this.hostsOf = options.hostsOf ?? (() => []);
    this.log = options.log ?? ((message) => console.warn(message));
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

  /** The tenants with these ids (hex) that are not in the trash, suspended ones included. */
  async visibleByIds(ids: readonly string[]): Promise<Tenant[]> {
    const valid = ids.filter((id) => ObjectId.isValid(id));
    if (valid.length === 0) return [];
    return this.collection.findMany({
      filter: { _id: { $in: valid.map((id) => new ObjectId(id)) } },
    });
  }

  /** The filter of `list` and `count`: the trash included, purged ones left out. */
  private filterOf({
    q,
    state,
    ids,
  }: Pick<TenantListOptions, "q" | "state" | "ids">) {
    const text = q?.trim() ?? "";
    return {
      purgeStartedAt: { $exists: false },
      ...(state === undefined ? {} : STATE_FILTER[state]),
      ...(ids === undefined
        ? {}
        : {
            _id: {
              $in: ids
                .filter((id) => ObjectId.isValid(id))
                .map((id) => new ObjectId(id)),
            },
          }),
      ...(text === ""
        ? {}
        : {
            $or: [
              { slug: { $regex: `^${escapeRegex(text.toLowerCase())}` } },
              { name: { $regex: escapeRegex(text), $options: "i" } },
            ],
          }),
    };
  }

  /** A page of tenants by slug, the trash included, purged ones left out. */
  list(options: TenantListOptions) {
    const text = options.q?.trim() ?? "";
    return this.collection.paginateByCursor({
      filter: this.filterOf(options),
      orderBy: "slug",
      limit: options.first,
      after: options.after,
      withDeleted: true,
      // A cursor of one search is refused on another.
      scope: JSON.stringify([
        text,
        options.state ?? null,
        options.ids !== undefined,
      ]),
    });
  }

  /** How many tenants `list` finds with these filters in all; `after` and `first` play no part. */
  count(options: Omit<TenantListOptions, "after" | "first">) {
    return this.collection.count(this.filterOf(options), {
      withDeleted: true,
    });
  }

  /** Renames the tenant or opens / closes its sign-up. A tenant in the trash is a `NotFoundError`. */
  update(
    id: IdOf<typeof tenants> | string,
    input: { name?: string | undefined; signUp?: boolean | undefined },
  ): Promise<Tenant> {
    const name = input.name?.trim();
    if (name === "") throw new TypeError("A tenant needs a name");
    return this.change(id, (tenant) => {
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
    id: IdOf<typeof tenants> | string,
    input: { plan: PlanId; quotaOverrides: QuotaOverrides },
  ): Promise<Tenant> {
    return this.change(id, (tenant) => {
      const same =
        tenant.plan === input.plan &&
        (["mau", "clients", "domains"] as const).every(
          (key) => tenant.quotaOverrides[key] === input.quotaOverrides[key],
        );
      return same
        ? null
        : { plan: input.plan, quotaOverrides: input.quotaOverrides };
    });
  }

  /** Puts the tenant in the trash; a tenant already there is returned as it is. */
  async trash(id: string): Promise<Tenant> {
    const tenant = await this.get(id);
    return tenant.deletedAt === null ? this.service.delete(tenant._id) : tenant;
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
        $set: { deletedAt: null, updatedAt: new Date() },
        $inc: { version: 1 },
      },
    );
    if (result.matchedCount === 0) return this.restore(id);
    const restored = await this.collection.getById(tenant._id);
    await this.changed(restored);
    return restored;
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

  // As `TenantsService.setStatus`: the version read is the version expected,
  // one retry on a conflict. `patch` answers `null` when nothing changes.
  private async change(
    id: IdOf<typeof tenants> | string,
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
        if (!(error instanceof OptimisticLockError) || attempt === 2) {
          throw error;
        }
      }
    }
  }

  private changed(tenant: Pick<Tenant, "slug" | "_id">) {
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
