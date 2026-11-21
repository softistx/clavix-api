import { mongo } from "@/config/db";
import { type Tenant, TenantsService } from "@/modules/tenants";
import { quietTenants } from "~/ports";

/** The two tenants calls the OAuth policy service makes; a spec gives their answers. */
export interface OAuthTenantsParts {
  liveByIds(ids: readonly string[]): Promise<Tenant[]>;
  updateOAuth(
    id: Parameters<TenantsService["updateOAuth"]>[0],
    change: (tenant: Tenant) => Tenant["oauth"] | null,
  ): Promise<Tenant>;
}

/** A real `TenantsService` (quiet ports) whose `liveByIds` and `updateOAuth` answer from `parts`. */
class TenantsOver extends TenantsService {
  constructor(private readonly parts: OAuthTenantsParts) {
    super(mongo.db.tenants, {
      ...quietTenants,
      now: () => new Date(),
      log: () => {},
    });
  }

  override liveByIds(ids: readonly string[]): Promise<Tenant[]> {
    return this.parts.liveByIds(ids);
  }

  override updateOAuth(
    id: Parameters<TenantsService["updateOAuth"]>[0],
    change: (tenant: Tenant) => Tenant["oauth"] | null,
  ): Promise<Tenant> {
    return this.parts.updateOAuth(id, change);
  }
}

export const tenantsOver = (parts: OAuthTenantsParts): TenantsService =>
  new TenantsOver(parts);
