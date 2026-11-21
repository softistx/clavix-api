import { ConflictError, OptimisticLockError } from "@softistx/mongo";
import type { BrandFields, StoredBrandingDoc } from "./branding.types";

/** How many times `update` decides before it gives up on concurrent writes. */
export const ATTEMPTS = 3;

/** Whether a write failed on a concurrent writer (a version or a unique index), so that deciding again may succeed. */
export const lostRace = (error: unknown): boolean =>
  error instanceof OptimisticLockError || error instanceof ConflictError;

/** Whether the stored brand already is exactly these fields (the logo compared by hash). */
export function sameBrand(
  stored: StoredBrandingDoc,
  fields: BrandFields,
): boolean {
  return (
    stored.displayName === fields.displayName &&
    stored.seed === fields.seed &&
    stored.radius === fields.radius &&
    stored.backgroundPreset === fields.backgroundPreset &&
    stored.motif === fields.motif &&
    stored.css === fields.css &&
    stored.logo?.hash === fields.logo?.hash
  );
}
