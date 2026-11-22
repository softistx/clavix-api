import type { TypedCollection } from "@softistx/mongo";
import type { Tenant, tenants } from "../tenants.model";
import type { TenantWriterOptions } from "../tenants.types";
import { dropHosts } from "../tenants.utils";

/**
 * The social apps a tenant's sign-in policy holds, written beside the typed
 * API (owner, 2026-11-20: one service per domain). It serves `keys:reseal`.
 */
export class TenantSocialService {
  constructor(
    private readonly collection: TypedCollection<typeof tenants>,
    private readonly options: TenantWriterOptions,
  ) {}

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
        $set: { "signIn.social": social, updatedAt: this.options.now() },
        $inc: { version: 1 },
      },
    );
    if (result.matchedCount === 0) return false;
    await dropHosts(this.options, tenant);
    return true;
  }
}
