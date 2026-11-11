import type { CollectionHooks } from "@softistx/mongo";
import type { tenants } from "./tenants.model";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const head = (path: string) => path.split(".")[0];

/** Throws when a patch writes or removes `slug`: as a field, under any operator, or in a `$rename`. */
export function refuseSlugChange(patch: unknown): void {
  if (!isRecord(patch)) return;
  for (const [key, value] of Object.entries(patch)) {
    const paths =
      key.startsWith("$") && isRecord(value)
        ? Object.entries(value).flatMap(([path, target]) =>
            key === "$rename" ? [path, String(target)] : [path],
          )
        : [key];
    if (paths.some((path) => head(path) === "slug")) {
      throw new TypeError(
        "A tenant's slug is immutable: its issuer is what relying parties registered",
      );
    }
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
