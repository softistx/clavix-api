import { denial } from "@softistx/janus-graphql";
import type { brandingService } from "@/config/branding";
import { tenantsService } from "@/config/tenancy";
import { fail } from "@/shared/errors";
import { BrandingConflictError } from "./branding.errors";
import { logoUrl } from "./branding.logo-route";
import {
  BrandingContrastError,
  BrandingInputError,
  THEME_NAME,
} from "./branding.theme";

// The guard decided who may touch the tenant; this decides it exists (a
// platform role is allowed on any id) and is not in the trash (a suspended
// tenant is readable; the guard refuses its writes).
export async function requireTenant(tenantId: string) {
  if ((await tenantsService.liveByIds([tenantId])).length === 0) {
    throw denial("NOT_FOUND", "No such tenant");
  }
}

export const shape = (
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
export function refusal(error: unknown): unknown {
  if (error instanceof BrandingContrastError) {
    return fail(error.code, error.message, {
      status: 422,
      extra: { failures: error.failures },
    });
  }
  if (error instanceof BrandingInputError) {
    return fail(error.code, error.message, {
      status: 400,
      field: error.field,
    });
  }
  if (error instanceof BrandingConflictError) {
    return fail(error.code, error.message, { status: 409 });
  }
  return error;
}
