import {
  connectionsService as connections,
  issuerChecker,
} from "@/config/connections";
import { catalogTenant } from "@/console/modules/catalog-support";
import { issuerFor } from "@/console/modules/issuer";
import type { Resolvers } from "@/generated/console/resolvers";
import { refusing } from "./connections.console-support";
import { checkOf, connectionShape } from "./utils";

export const connectionQueries: NonNullable<Resolvers["Query"]> = {
  connections: async (_, { tenantId }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const issuer = await issuerFor(tenant);
    return (await connections.list(tenant._id.toHexString())).map((doc) =>
      connectionShape(doc, issuer),
    );
  },
  connection: async (_, { tenantId, id }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const found = await connections.find(tenant._id.toHexString(), id);
    return found === undefined
      ? null
      : connectionShape(found, await issuerFor(tenant));
  },
  checkConnection: async (_, { tenantId, input }, ctx) => {
    await catalogTenant(ctx, tenantId);
    return refusing(() => issuerChecker(checkOf(input)));
  },
};
