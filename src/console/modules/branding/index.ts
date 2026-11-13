import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import { ObjectId } from "mongodb";
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
import { type Guards, onTenant } from "../../guard";

const tenantIdOf = (args: Record<string, unknown>) => String(args["tenantId"]);

export const brandingGuards: Guards = {
  "Query.branding": onTenant("view", tenantIdOf),
  "Mutation.updateBranding": onTenant("edit", tenantIdOf),
};

// The guard decided who may touch the tenant; this decides it exists (a
// platform role is allowed on any id) and is active.
async function requireTenant(tenantId: string) {
  if (
    ObjectId.isValid(tenantId) &&
    (await tenantsService.activeByIds([tenantId])).length === 1
  ) {
    return;
  }
  throw denial("NOT_FOUND", "No such tenant");
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

export const branding: Resolvers = {
  Query: {
    branding: async (_, { tenantId }) => {
      await requireTenant(tenantId);
      const found = await brandingService.get(tenantId);
      return found === undefined ? null : shape(tenantId, found);
    },
  },
  Mutation: {
    updateBranding: async (_, { tenantId, input }) => {
      await requireTenant(tenantId);
      try {
        const result = await brandingService.update(tenantId, {
          displayName: input.displayName,
          seed: input.seed,
          radius: input.radius ?? "0.5rem",
          backgroundPreset: input.backgroundPreset ?? null,
          motif: input.motif ?? null,
          logo: input.logo ?? undefined,
          removeLogo: input.removeLogo ?? undefined,
        });
        return {
          branding: shape(tenantId, result.branding),
          changed: result.changed,
          warnings: result.warnings,
        };
      } catch (error) {
        if (error instanceof BrandingContrastError) {
          throw new GraphQLError(error.message, {
            extensions: {
              code: error.code,
              http: { status: 422 },
              failures: error.failures,
            },
          });
        }
        if (error instanceof BrandingInputError) {
          throw new GraphQLError(error.message, {
            extensions: {
              code: error.code,
              http: { status: 400 },
              field: error.field,
            },
          });
        }
        if (error instanceof BrandingConflictError) {
          throw new GraphQLError(error.message, {
            extensions: { code: error.code, http: { status: 409 } },
          });
        }
        throw error;
      }
    },
  },
};
