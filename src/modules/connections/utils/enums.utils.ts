/** The console's enum values and the stored ones, both ways. */
export const TRUST = {
  claimAndDomain: "CLAIM_AND_DOMAIN",
  domain: "DOMAIN",
} as const;
export const TRUST_IN = {
  CLAIM_AND_DOMAIN: "claimAndDomain",
  DOMAIN: "domain",
} as const;
export const AUTH = { post: "POST", basic: "BASIC" } as const;
export const AUTH_IN = { POST: "post", BASIC: "basic" } as const;
