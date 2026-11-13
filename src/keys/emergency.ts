import { rotateSigningKeys } from "@softistx/janus-oauth";
import { retireAfterMs, rotationPolicy } from "./policy";
import type { TenantKeys } from "./signing-keys";

export interface EmergencyRotationDeps {
  signingKeysFor: TenantKeys["signingKeysFor"];
  /** The tenants to rotate (hex ids). */
  tenantIds: readonly string[];
  /**
   * Unpublish the retired key at once, for a leaked private key: tokens it
   * signed stop verifying. Default: it stays published for the retirement
   * window (`rotationPolicy.retireAfter`), so live tokens keep verifying.
   */
  dropOld?: boolean;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface EmergencyRotation {
  tenantId: string;
  /** The kid that signed until now; `null` when the tenant had no current key. */
  retired: string | null;
  /** The kid that signs from now on. */
  current: string | null;
}

/**
 * "Rotate now": retires each tenant's current key (`retire`, janus's emergency
 * stop for one key) and runs the normal rotation step, which promotes the
 * published `next` key at once, or inserts a fresh `current` one. Only the
 * public port is used: nothing is deleted by hand. A tenant that fails is
 * logged and the others go on; the result lists what each one did.
 */
export async function rotateNow({
  signingKeysFor,
  tenantIds,
  dropOld = false,
  now = () => new Date(),
  log = (message) => console.warn(message),
}: EmergencyRotationDeps): Promise<{
  rotated: EmergencyRotation[];
  failed: number;
}> {
  const rotated: EmergencyRotation[] = [];
  let failed = 0;
  for (const tenantId of tenantIds) {
    try {
      const store = signingKeysFor(tenantId);
      const at = now();
      const current = await store.findCurrentKey(at);
      if (current !== null) {
        const publishUntil = dropOld
          ? at
          : new Date(at.getTime() + retireAfterMs);
        await store.retire(current.kid, at, publishUntil);
      }
      await rotateSigningKeys(store, { ...rotationPolicy, now: at });
      const next = await store.findCurrentKey(at);
      rotated.push({
        tenantId,
        retired: current?.kid ?? null,
        current: next?.kid ?? null,
      });
    } catch (error) {
      failed += 1;
      log(
        `keys: rotate failed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { rotated, failed };
}
