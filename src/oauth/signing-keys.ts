import type { SigningKeyStore } from "@softistx/janus-oauth";

/** A tenant has no `current` signing key yet (just created, rotation pending). */
export class NoSigningKeyError extends Error {
  constructor(readonly tenantId: string) {
    super(`tenant ${tenantId} has no current signing key yet`);
    this.name = "NoSigningKeyError";
  }
}

// Temporary, until @softistx/janus-oauth#683
// The store janus signs with, failing with a typed error (not janus's bare
// `Error`) when the tenant has no current key, so `handle` can answer it.
export function requiringCurrentKey(
  store: SigningKeyStore,
  tenantId: string,
): SigningKeyStore {
  return new Proxy(store, {
    get(target, property) {
      if (property !== "findCurrentKey") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (now: Date) => {
        const key = await target.findCurrentKey(now);
        if (key === null) throw new NoSigningKeyError(tenantId);
        return key;
      };
    },
  });
}

/** 503 with `Retry-After`: the keys of a new tenant arrive within moments. */
export const unavailable = () =>
  Response.json(
    {
      error: "temporarily_unavailable",
      error_description: "the issuer has no signing key yet, retry shortly",
    },
    {
      status: 503,
      headers: { "retry-after": "30", "cache-control": "no-store" },
    },
  );
