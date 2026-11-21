import type { Resolvers } from "@/generated/graphql/resolvers";
import { homeRealmOf } from "@/modules/users";
import {
  homeRealmScope,
  offeredConnection,
} from "./connections.resolver-support";

export const connections: Resolvers = {
  Query: {
    hostedHomeRealm: async (_, { email }, ctx) => {
      const { auth, tenant } = await homeRealmScope(ctx);
      const connectionId = await homeRealmOf(auth, email);
      if (connectionId === null) return null;
      return offeredConnection(tenant.tenantId, connectionId);
    },
  },
};
