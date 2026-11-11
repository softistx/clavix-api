import {
  ConflictError,
  type IdOf,
  type TypedCollection,
} from "@softistx/mongo";
import { env } from "@/config/env";
import { hostOf } from "./identity";
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
   * Called with the hosts whose resolution may have changed, after a write
   * (the resolver's cache drops them from step 3 of slice 1.1). Default: none.
   */
  onHostsChanged?: (hosts: string[]) => void | Promise<void>;
}

/** The platform's tenants: create, suspend, reactivate, delete. The slug never changes. */
export class TenantsService {
  private readonly domain: string;
  private readonly onHostsChanged: (hosts: string[]) => void | Promise<void>;

  constructor(
    private readonly collection: TypedCollection<typeof tenants>,
    options: TenantsServiceOptions = {},
  ) {
    this.domain = options.domain ?? env.CLAVIX_DOMAIN;
    this.onHostsChanged = options.onHostsChanged ?? (() => {});
  }

  async create(input: { slug: string; name: string }): Promise<Tenant> {
    const problem = slugProblem(input.slug);
    if (problem !== undefined) throw new InvalidSlugError(problem);
    const name = input.name.trim();
    if (name === "") throw new TypeError("A tenant needs a name");
    let created: Tenant;
    try {
      created = await this.collection.create({ slug: input.slug, name });
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new SlugTakenError(`The slug "${input.slug}" is taken`);
      }
      throw error;
    }
    await this.changed(created);
    return created;
  }

  suspend(id: IdOf<typeof tenants> | string): Promise<Tenant> {
    return this.setStatus(id, "suspended");
  }

  reactivate(id: IdOf<typeof tenants> | string): Promise<Tenant> {
    return this.setStatus(id, "active");
  }

  /** Archives the tenant (soft delete); its slug is free again. */
  async delete(id: IdOf<typeof tenants> | string): Promise<Tenant> {
    const tenant = await this.collection.getById(id);
    this.refuseIfPlatform(tenant, "deleted");
    const deleted = await this.collection.delete(tenant._id);
    await this.changed(deleted);
    return deleted;
  }

  private async setStatus(
    id: IdOf<typeof tenants> | string,
    status: Tenant["status"],
  ): Promise<Tenant> {
    const tenant = await this.collection.getById(id);
    if (status === "suspended") this.refuseIfPlatform(tenant, "suspended");
    if (tenant.status === status) return tenant;
    const updated = await this.collection.update(tenant._id, { status });
    await this.changed(updated);
    return updated;
  }

  private refuseIfPlatform(tenant: Tenant, what: string) {
    if (tenant.slug === PLATFORM_TENANT_SLUG) {
      throw new PlatformTenantProtectedError(
        `The platform tenant "${PLATFORM_TENANT_SLUG}" cannot be ${what}`,
      );
    }
  }

  private changed(tenant: Tenant) {
    return this.onHostsChanged([hostOf(tenant.slug, this.domain)]);
  }
}
