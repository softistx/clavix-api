import type { ObjectId } from "mongodb";

/** Where tenants' issuers live: from `CLAVIX_DOMAIN` and the public scheme/port. */
export interface PublicOrigin {
  scheme: "https" | "http";
  domain: string;
  port?: number | undefined;
}

/** The host a tenant is served on: `<slug>.<domain>`, without a port. */
export const hostOf = (slug: string, domain: string) => `${slug}.${domain}`;

/** The tenant's OIDC issuer: `<scheme>://<slug>.<domain>[:port]`. Derived, never stored. */
export const issuerOf = (slug: string, origin: PublicOrigin) =>
  `${origin.scheme}://${hostOf(slug, origin.domain)}${
    origin.port === undefined ? "" : `:${origin.port}`
  }`;

/** The issuer served on `host` (a slug host or a custom domain), same scheme and port. */
export const issuerOfHost = (host: string, origin: PublicOrigin) =>
  `${origin.scheme}://${host}${origin.port === undefined ? "" : `:${origin.port}`}`;

/** The janus partition (`createMongoOAuth(db, { partition })`): the tenant's id in hex. */
export const partitionOf = (id: ObjectId) => id.toHexString();
