import { scopeToTenant, type TypedCollection } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { detailTypes } from "./detail-types.model";

/**
 * What a client's opt-in to detail types (R3, D3) needs to know of a tenant:
 * the types it stores, and whether its consent page can show them.
 */
export interface ClientDetailTypes {
  /** The names of the tenant's stored detail types (read through its scope). */
  namesOf(tenant: { _id: ObjectId }): Promise<ReadonlySet<string>>;
  /**
   * Whether the tenant may let a client that uses `/authorize` list detail
   * types. janus approves every detail of a request it validated; the consent
   * page that shows them (V4) is not there yet, so a code client of a tenant
   * that has not opted in cannot list a type (`rarConsentReady`, removed in V4).
   */
  consentReady(tenant: { slug: string }): boolean;
}

/**
 * The tenants that opted in, from `CLAVIX_RAR_CONSENT_READY`: slugs separated
 * by commas, or `*` for every tenant. Empty (the default): none.
 */
export function consentReadyOf(list: string): (slug: string) => boolean {
  const slugs = new Set(
    list
      .split(",")
      .map((slug) => slug.trim())
      .filter((slug) => slug !== ""),
  );
  return (slug) => slugs.has("*") || slugs.has(slug);
}

/** The real port over the `detailTypes` collection. */
export function mongoClientDetailTypes(
  docs: TypedCollection<typeof detailTypes>,
  consentReady: (slug: string) => boolean,
): ClientDetailTypes {
  return {
    async namesOf(tenant) {
      const found = await scopeToTenant(docs, tenant._id).findMany();
      return new Set(found.map((doc) => doc.type));
    },
    consentReady: (tenant) => consentReady(tenant.slug),
  };
}
