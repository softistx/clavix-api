import type { CollectionHooks } from "@softistx/mongo";
import { patchTouches } from "@/tenancy/patch-paths";
import type { tenants } from "./tenants.model";

/** Throws when a patch writes or removes `slug`: as a field, under any operator, or in a `$rename`. */
export function refuseSlugChange(patch: unknown): void {
  if (patchTouches(patch, "slug")) {
    throw new TypeError(
      "A tenant's slug is immutable: its issuer is what relying parties registered",
    );
  }
}

/**
 * The slug never changes through the typed API: `update`, `updateMany` and
 * `upsert` (its values; the filter may name the slug to identify a tenant) are
 * refused when they touch it. Wired in src/config/db.ts (`optionsFor`).
 * `raw` runs no hooks and is out of reach by design.
 */
export const tenantHooks: CollectionHooks<typeof tenants> = {
  beforeUpdate: ({ patch }) => refuseSlugChange(patch),
  beforeUpdateMany: ({ patch }) => refuseSlugChange(patch),
  beforeUpsert: ({ values }) => refuseSlugChange(values),
};
