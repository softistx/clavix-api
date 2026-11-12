import type { RotateSigningKeysOptions } from "@softistx/janus-oauth";

// The rotation cadence (owner decision, assumed, softistx/clavix-api#24): a key
// signs for 90 days; the next one is published 48 h before it takes over, so
// clients have cached it; a retired key stays published 24 h, longer than an
// access token lives. ES256 is ADR-0010's default; EdDSA is opt-in per tenant
// later.
export const rotationPolicy = {
  every: "90d",
  lead: "48h",
  retireAfter: "24h",
  alg: "ES256",
} as const satisfies Omit<RotateSigningKeysOptions, "now">;
