import type { Resolvers } from "@/generated/graphql/resolvers";
import { services } from "@/modules/services";

export const branding: Resolvers = {
  Query: {
    tenantBranding: async (_, __, ctx) => {
      const tenant = await ctx.tenant();
      return tenant === null ? null : services().branding.view(tenant.tenantId);
    },
  },
};
