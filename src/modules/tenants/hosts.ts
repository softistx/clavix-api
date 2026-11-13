import type { ObjectId } from "mongodb";
import { hostOf } from "./identity";

export interface TenantHostsHooks {
  /** The apex tenants' hosts hang under. */
  domain: string;
  hostsOf: (tenantId: ObjectId) => string[] | Promise<string[]>;
  onHostsChanged: (hosts: string[]) => void | Promise<void>;
  log: (message: string) => void;
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * After a tenant write: drops the tenant's slug host and its custom hosts from
 * the resolver's cache. Errors are logged and swallowed, the write stands.
 */
export async function dropTenantHosts(
  hooks: TenantHostsHooks,
  tenant: { _id: ObjectId; slug: string },
): Promise<void> {
  const hosts = [hostOf(tenant.slug, hooks.domain)];
  try {
    hosts.push(...(await hooks.hostsOf(tenant._id)));
  } catch (error) {
    hooks.log(`tenants: hostsOf failed for ${hosts[0]}: ${reason(error)}`);
  }
  try {
    await hooks.onHostsChanged(hosts);
  } catch (error) {
    hooks.log(
      `tenants: onHostsChanged failed for ${hosts.join(", ")}: ${reason(error)}`,
    );
  }
}
