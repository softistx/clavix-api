import { rotateSigningKeys } from "@softistx/janus-oauth";
import { rotationPolicy } from "./policy";
import type { TenantKeys } from "./signing-keys";

export interface RotationDeps {
  signingKeysFor: TenantKeys["signingKeysFor"];
  /** The ids (hex) of the tenants that sign: the active ones. */
  activeTenantIds: () => Promise<string[]>;
  now: () => Date;
  log: (message: string) => void;
}

/**
 * One rotation pass over every active tenant. It also creates the first key of
 * a tenant that has none (janus's step inserts a `current` key into an empty
 * store). A tenant that fails is logged and the others go on; the result says
 * how many failed so the job can retry.
 */
export async function rotateAllTenants({
  signingKeysFor,
  activeTenantIds,
  now,
  log,
}: RotationDeps) {
  let rotated = 0;
  let failed = 0;
  for (const tenantId of await activeTenantIds()) {
    try {
      await rotateSigningKeys(signingKeysFor(tenantId), {
        ...rotationPolicy,
        now: now(),
      });
      rotated += 1;
    } catch (error) {
      failed += 1;
      log(
        `keys: rotation failed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { rotated, failed };
}

/** Makes sure the tenant has a signing key (its first, or a replacement): the same idempotent step. */
export function ensureSigningKey(
  signingKeysFor: TenantKeys["signingKeysFor"],
  tenantId: string,
  now: Date,
) {
  return rotateSigningKeys(signingKeysFor(tenantId), {
    ...rotationPolicy,
    now,
  });
}
