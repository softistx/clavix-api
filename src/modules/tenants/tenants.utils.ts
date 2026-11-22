import { ObjectId } from "mongodb";
import type { Tenant } from "./tenants.model";
import type {
  PublicOrigin,
  RegisteredTenant,
  TenantHostsOptions,
  TenantListOptions,
  TenantState,
} from "./tenants.types";

/** The host a tenant is served on: `<slug>.<domain>`, without a port. */
export const hostOf = (slug: string, domain: string) => `${slug}.${domain}`;

/** The tenant's OIDC issuer: `<scheme>://<slug>.<domain>[:port]`. Derived, never stored. */
export const issuerOf = (slug: string, origin: PublicOrigin) =>
  `${origin.scheme}://${hostOf(slug, origin.domain)}${
    origin.port === undefined ? "" : `:${origin.port}`
  }`;

/** The issuer served on `host` (a slug host or a custom domain), same scheme and port. */
export const issuerOfHost = (host: string, origin: PublicOrigin) =>
  `${origin.scheme}://${host}${origin.port === undefined ? "" : `:${origin.port}`}`;

/** The janus partition (`createMongoOAuth(db, { partition })`): the tenant's id in hex. */
export const partitionOf = (id: ObjectId) => id.toHexString();

/** Why a thrown value failed, in words for a log line. */
export const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A regular expression that matches `text` literally. */
export const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The valid ObjectIds among hex ids. */
export const objectIdsOf = (ids: readonly string[]) =>
  ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));

/** A stored tenant, as a registration reports it. */
export const registeredOf = (
  tenant: Tenant,
  created: boolean,
): RegisteredTenant => ({
  created,
  tenantId: partitionOf(tenant._id),
  slug: tenant.slug,
  name: tenant.name,
  status: tenant.status,
  signUp: tenant.signUp,
});

/** A stored tenant's state; `null` once its purge started (it is gone for everyone). */
export const stateOf = (tenant: {
  status: Tenant["status"];
  deletedAt: Date | null;
  purgeStartedAt?: Date | undefined;
}): TenantState | null => {
  if (tenant.purgeStartedAt !== undefined) return null;
  return tenant.deletedAt === null ? tenant.status : "deleted";
};

const STATE_FILTER = {
  active: { status: "active", deletedAt: null },
  suspended: { status: "suspended", deletedAt: null },
  deleted: { deletedAt: { $ne: null } },
  live: { deletedAt: null },
} as const;

/** The filter of `list` and `count`: the trash included, purged ones left out. */
export function listFilterOf({
  q,
  state,
  ids,
}: Pick<TenantListOptions, "q" | "state" | "ids">) {
  const text = q?.trim() ?? "";
  return {
    purgeStartedAt: { $exists: false },
    ...(state === undefined ? {} : STATE_FILTER[state]),
    ...(ids === undefined ? {} : { _id: { $in: objectIdsOf(ids) } }),
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

/** The scope a cursor of one search is bound to: another search refuses it. */
export const listScopeOf = (options: TenantListOptions) =>
  JSON.stringify([
    options.q?.trim() ?? "",
    options.state ?? null,
    options.ids !== undefined,
  ]);

/**
 * After a tenant write: drops the tenant's slug host and its custom hosts
 * from the resolver's cache. Errors are logged and swallowed, the write
 * stands.
 */
export async function dropHosts(
  options: TenantHostsOptions,
  tenant: Pick<Tenant, "slug" | "_id">,
): Promise<void> {
  const hosts = [hostOf(tenant.slug, options.domain)];
  try {
    hosts.push(...(await options.hostsOf(tenant._id)));
  } catch (error) {
    options.log(`tenants: hostsOf failed for ${hosts[0]}: ${reasonOf(error)}`);
  }
  try {
    await options.onHostsChanged(hosts);
  } catch (error) {
    options.log(
      `tenants: onHostsChanged failed for ${hosts.join(", ")}: ${reasonOf(error)}`,
    );
  }
}
