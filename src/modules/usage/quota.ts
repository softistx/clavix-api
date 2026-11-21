import type { QuotaKey } from "@/modules/tenants";

/** A hard quota (`clients`, `domains`) would be passed by the creation. */
export class QuotaExceededError extends Error {
  override name = "QuotaExceededError";
  constructor(
    readonly key: QuotaKey,
    readonly quota: number,
  ) {
    super(`The plan allows ${quota} ${key}; the quota is reached`);
  }
}

/**
 * Refuses a creation that would pass a hard quota: `used` is the count before
 * it. `null` (no limit) always passes. For `clients` (A2a) and `domains` (A4).
 */
export function assertWithinQuota(
  key: Exclude<QuotaKey, "mau">,
  used: number,
  quota: number | null,
): void {
  if (quota !== null && used >= quota) throw new QuotaExceededError(key, quota);
}
