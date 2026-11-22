import type { ObjectId } from "mongodb";

/** What an admin event names: the connection and its tenant. Never the issuer, a domain or a secret. */
export const connectionTarget = (tenantId: ObjectId, id: string) => ({
  type: "connection",
  id,
  tenantId: tenantId.toHexString(),
});

/** The `Exclusive` key of a tenant's connections (the quota count and the insert are not atomic; domain claims must not race). */
export const connectionsKey = (tenant: { _id: ObjectId }) =>
  `console:connections:${tenant._id.toHexString()}`;
