import { brandingService } from "@/config/branding";
import type { Resolvers } from "@/generated/graphql/resolvers";
import { logoUrl } from "./logo-route";
import { THEME_NAME } from "./theme";

export const branding: Resolvers = {
  Query: {
    tenantBranding: async (_, __, ctx) => {
      const tenant = await ctx.tenant();
      if (tenant === null) return null;
      const found = await brandingService.get(tenant.tenantId);
      return found === undefined
        ? null
        : {
            displayName: found.displayName,
            themeName: THEME_NAME,
            css: found.css,
            logoUrl: found.logo === null ? null : logoUrl(found.logo.hash),
          };
    },
  },
};
