import { ObjectId } from "mongodb";
import {
  discoverIssuer,
  type IssuerChecker,
} from "@/modules/connections/connections.discovery";
import { ConnectionsService } from "@/modules/connections/connections.service";
import { systemTxtResolver } from "@/modules/domains/dns";
import { mongo } from "./db";
import { connectionSecretBox } from "./keys";
import { oauthDb } from "./oauth-db";

// Temporary, until nxgt-janus#TBD (a count of the links of one provider): the
// accounts linked through a connection are counted in janus-mongo's
// `partitionedSocialLinks` collection, keyed by the tenant's partition (its
// hex id) and the provider name, which is the connection's id.
const linkCount = (tenantId: string, connectionId: string) =>
  oauthDb.collection("partitionedSocialLinks").countDocuments({
    partition: new ObjectId(tenantId).toHexString(),
    provider: connectionId,
  });

/** The enterprise OIDC connections of the tenants. The collection is tenant-owned: only this wiring and its module reach it. */
export const connectionsService = new ConnectionsService(
  mongo.db.connections,
  connectionSecretBox,
  { txt: systemTxtResolver(), links: linkCount },
);

/** Reads an issuer's discovery document for the console's check (the network). */
export const issuerChecker: IssuerChecker = discoverIssuer;
