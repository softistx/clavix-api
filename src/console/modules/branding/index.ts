import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import { brandingService } from "@/config/branding";
import { tenantsService } from "@/config/tenancy";
import type { Resolvers } from "@/generated/console/resolvers";
import { BrandingConflictError } from "@/modules/branding/branding.service";
import { logoUrl } from "@/modules/branding/logo-route";
import {
  BrandingContrastError,
  BrandingInputError,
  THEME_NAME,
} from "@/modules/branding/theme";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import { tenantArg, tenantIdOf } from "../ids";

export const brandingGuards: Guards = {
  "Query.branding": onTenant("view", tenantArg),
  "Mutation.updateBranding": onTenant("edit", tenantArg),
};

export const brandingAudits: Audits = {
  "Mutation.updateBranding": "branding.update",
};

// The guard decided who may touch the tenant; this decides it exists (a
// platform role is allowed on any id) and is active.
async function requireTenant(tenantId: string) {
  if ((await tenantsService.activeByIds([tenantId])).length === 0) {
    throw denial("NOT_FOUND", "No such tenant");
  }
}

const shape = (
  tenantId: string,
  doc: NonNullable<Awaited<ReturnType<typeof brandingService.get>>>,
) => ({
  tenantId,
  displayName: doc.displayName,
  seed: doc.seed,
  radius: doc.radius,
  backgroundPreset: doc.backgroundPreset,
  motif: doc.motif,
  themeName: THEME_NAME,
  css: doc.css,
  logoUrl: doc.logo === null ? null : logoUrl(doc.logo.hash),
  updatedAt: doc.updatedAt,
});

// The service's refusals as GraphQL errors; anything else passes through.
function refusal(error: unknown): unknown {
  if (error instanceof BrandingContrastError) {
    return new GraphQLError(error.message, {
      extensions: {
        code: error.code,
        http: { status: 422 },
        failures: error.failures,
      },
    });
  }
  if (error instanceof BrandingInputError) {
    return new GraphQLError(error.message, {
      extensions: {
        code: error.code,
        http: { status: 400 },
        field: error.field,
      },
    });
  }
  if (error instanceof BrandingConflictError) {
    return new GraphQLError(error.message, {
      extensions: { code: error.code, http: { status: 409 } },
    });
  }
  return error;
}

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
