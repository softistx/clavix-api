import { scopeToTenant, type TypedCollection } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { BrandingConflictError } from "./branding.errors";
import { checkLogo, type StoredLogo } from "./branding.logo";
import { logoUrl } from "./branding.logo-route";
import type { branding } from "./branding.model";
import {
  buildTheme,
  type CompileTheme,
  compileTheme,
  THEME_NAME,
  type ValidThemeInput,
} from "./branding.theme";
import type {
  BrandFields,
  PublicBranding,
  StoredBrandingDoc,
  UpdateBrandingInput,
  UpdateBrandingResult,
} from "./branding.types";
import { ATTEMPTS, lostRace, sameBrand } from "./branding.utils";

export type {
  StoredBrandingDoc,
  UpdateBrandingInput,
  UpdateBrandingResult,
} from "./branding.types";

/**
 * A tenant's brand. Every method takes the tenant id (hex) and reads or writes
 * through that tenant's scope, so a brand of A is never visible to B.
 */
export class BrandingService {
  constructor(
    private readonly collection: TypedCollection<typeof branding>,
    private readonly compile: CompileTheme = compileTheme,
  ) {}

  private scoped(tenantId: string) {
    return scopeToTenant(this.collection, new ObjectId(tenantId));
  }

  async get(tenantId: string): Promise<StoredBrandingDoc | undefined> {
    return this.scoped(tenantId).findFirst({});
  }

  /** The brand the hosted pages show (`tenantBranding`); `null` while none is stored. */
  async view(tenantId: string): Promise<PublicBranding | null> {
    const found = await this.get(tenantId);
    if (found === undefined) return null;
    return {
      displayName: found.displayName,
      themeName: THEME_NAME,
      css: found.css,
      backgroundPreset: found.backgroundPreset,
      motif: found.motif,
      logoUrl: found.logo === null ? null : logoUrl(found.logo.hash),
    };
  }

  /**
   * Replaces the brand (the theme fields are all given; the logo is kept
   * unless replaced or removed). Throws `BrandingInputError` and
   * `BrandingContrastError`, before anything is stored.
   */
  async update(
    tenantId: string,
    input: UpdateBrandingInput,
  ): Promise<UpdateBrandingResult> {
    const { input: valid, compiled } = buildTheme(input, this.compile);
    const newLogo: StoredLogo | undefined =
      input.logo === undefined ? undefined : checkLogo(input.logo);
    // Each attempt reads the brand, decides, and writes at the version it
    // read. A concurrent writer makes the write fail (`OptimisticLockError`,
    // or `ConflictError` on the unique index for a first write), and the next
    // attempt decides again on what that writer stored: a logo it replaced or
    // removed is never put back, and an identical call becomes a no-op.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.write(tenantId, valid, newLogo, input.removeLogo, {
          warnings: compiled.warnings,
          css: compiled.css,
        });
      } catch (error) {
        if (!lostRace(error)) throw error;
        if (attempt >= ATTEMPTS) throw new BrandingConflictError();
      }
    }
  }

  private async write(
    tenantId: string,
    valid: ValidThemeInput,
    newLogo: StoredLogo | undefined,
    removeLogo: boolean | undefined,
    compiled: { css: string; warnings: string[] },
  ): Promise<UpdateBrandingResult> {
    const { warnings } = compiled;
    const scoped = this.scoped(tenantId);
    const existing = await scoped.findFirst({});
    const logo =
      removeLogo === true && newLogo === undefined
        ? null
        : (newLogo ?? existing?.logo ?? null);
    const fields: BrandFields = {
      displayName: valid.displayName,
      seed: valid.seed,
      radius: valid.radius,
      backgroundPreset: valid.backgroundPreset,
      motif: valid.motif,
      css: compiled.css,
      logo,
    };
    if (existing !== undefined && sameBrand(existing, fields)) {
      return { branding: existing, changed: false, warnings };
    }
    if (existing === undefined) {
      const created = await scoped.create(fields);
      return { branding: created, changed: true, warnings };
    }
    const updated = await scoped.update(existing._id, {
      ...fields,
      version: existing.version,
    });
    return { branding: updated, changed: true, warnings };
  }
}
