import type { ObjectId } from "mongodb";
import type { DomainDoc } from "./domains.model";
import { txtNameOf } from "./domains.rules";

/** The TXT value to publish: random per claim, so it names this tenant's claim on this host. */
export const mintToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `clavix-verify=${Buffer.from(bytes).toString("base64url")}`;
};

/** What an admin event names: the claim's id and its tenant. Never the token. */
export const target = (tenantId: ObjectId, id: string) => ({
  type: "domain",
  id,
  tenantId: tenantId.toHexString(),
});

/** The `Exclusive` key of a tenant's domain claims. */
export const domainsKey = (tenant: { _id: ObjectId }) =>
  `console:domains:${tenant._id.toHexString()}`;

/** A claim as the console shows it. */
export const shape = (doc: DomainDoc) => ({
  id: doc._id.toHexString(),
  host: doc.host,
  status: doc.status.toUpperCase() as "PENDING" | "VERIFIED" | "UNVERIFIED",
  txtRecord: { name: txtNameOf(doc.host), value: doc.txtToken },
  primary: doc.primary,
  verifiedAt: doc.verifiedAt,
  checkedAt: doc.checkedAt,
  createdAt: doc.createdAt,
});
