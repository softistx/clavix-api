import { denial } from "@softistx/janus-graphql";
import { connectionsService } from "@/config/connections";
import { janusIssuers } from "@/config/users";
import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireLive } from "@/tenancy/live";
import { homeRealmOf } from "@/users/tenant-janus";

export const connections: Resolvers = {
  Query: {
    hostedHomeRealm: async (_, { email }, ctx) => {
      const [auth, tenant] = await Promise.all([
        janusIssuers.forRequest(ctx.request),
        ctx.tenant(),
      ]);
      if (auth === null || tenant === null) {
        throw denial("NOT_FOUND", "No such tenant");
      }
      requireLive(tenant);
      ctx.set.headers.set("cache-control", "no-store");
      await ctx.homeRealmThrottle?.check({
        tenantId: tenant.tenantId,
        ip: ctx.ip,
      });
      const connectionId = await homeRealmOf(auth, email);
      if (connectionId === null) return null;
      const doc = await connectionsService.find(tenant.tenantId, connectionId);
      return doc === undefined || !doc.enabled
        ? null
        : { connectionId, name: doc.name };
    },
  },
};
