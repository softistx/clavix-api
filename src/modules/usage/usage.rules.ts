import type { QuotaKey } from "@/modules/tenants";
import { QuotaExceededError } from "./usage.errors";

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
