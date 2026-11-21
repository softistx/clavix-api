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
