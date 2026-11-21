import { brandingService } from "@/config/branding";
import { tenantIdOf } from "@/console/modules/ids";
import type { Resolvers } from "@/generated/console/resolvers";
import { refusal, requireTenant, shape } from "./branding.console-support";

export { brandingAudits, brandingGuards } from "./branding.console-guards";

export const branding: Resolvers = {
  Query: {
    branding: async (_, { tenantId: given }) => {
      const tenantId = tenantIdOf(given);
      await requireTenant(tenantId);
      const found = await brandingService.get(tenantId);
      return found === undefined ? null : shape(tenantId, found);
    },
  },
  Mutation: {
    updateBranding: async (_, { tenantId: given, input }, ctx) => {
      // One spelling of the id in the trail, whatever case the caller sent.
      const tenantId = tenantIdOf(given);
      await requireTenant(tenantId);
      const result = await brandingService
        .update(tenantId, {
          displayName: input.displayName,
          seed: input.seed,
          radius: input.radius ?? "0.5rem",
          backgroundPreset: input.backgroundPreset ?? null,
          motif: input.motif ?? null,
          logo: input.logo ?? undefined,
          removeLogo: input.removeLogo ?? undefined,
        })
        .catch((error: unknown) => {
          throw refusal(error);
        });
      // Outside the mapping above: a failed record fails the mutation as it
      // is. Recorded on a repeat too (`changed: false`): the retry of a call
      // whose record failed must not leave the change with no event. A tenant
      // has one brand, so the tenant's id names it.
      await ctx.audit("branding.update", {
        type: "branding",
        id: tenantId,
        tenantId,
      });
      return {
        branding: shape(tenantId, result.branding),
        changed: result.changed,
        warnings: result.warnings,
      };
    },
  },
};
