import {
  ConflictError,
  OptimisticLockError,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { branding } from "./branding.model";
import { checkLogo, type StoredLogo } from "./logo";
import {
  buildTheme,
  type CompileTheme,
  compileTheme,
  type ThemeInput,
  type ValidThemeInput,
} from "./theme";

export type StoredBrandingDoc = Awaited<
  ReturnType<TypedCollection<typeof branding>["create"]>
>;

export interface UpdateBrandingInput extends ThemeInput {
  /** Replace the logo. Omitted: keep it. */
  logo?: { contentType: string; dataBase64: string } | undefined;
  removeLogo?: boolean | undefined;
}

export interface UpdateBrandingResult {
  branding: StoredBrandingDoc;
  /** `false` when the stored brand already was exactly this (idempotent). */
  changed: boolean;
  /** What the generator adjusted to reach AA. */
  warnings: string[];
}

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
    // read. A concurrent writer makes the write fail (`OptimisticLockError`),
    // and the next attempt decides again on what that writer stored, so a
    // logo it replaced or removed is never put back by this call.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.write(tenantId, valid, newLogo, input.removeLogo, {
          warnings: compiled.warnings,
          css: compiled.css,
        });
      } catch (error) {
        if (!(error instanceof OptimisticLockError) || attempt >= ATTEMPTS) {
          throw error;
        }
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
    let existing = await scoped.findFirst({});
    const logo =
      removeLogo === true && newLogo === undefined
        ? null
        : (newLogo ?? existing?.logo ?? null);
    const fields = {
      displayName: valid.displayName,
      seed: valid.seed,
      radius: valid.radius,
      backgroundPreset: valid.backgroundPreset,
      motif: valid.motif,
      css: compiled.css,
      logo,
    };
    if (existing !== undefined && same(existing, fields)) {
      return { branding: existing, changed: false, warnings };
    }
    if (existing === undefined) {
      try {
        const created = await scoped.create(fields);
        return { branding: created, changed: true, warnings };
      } catch (error) {
        // A concurrent first write won the unique index: update it instead.
        if (!(error instanceof ConflictError)) throw error;
        existing = await scoped.findFirst({});
        if (existing === undefined) throw error;
        if (newLogo === undefined && removeLogo !== true) {
          fields.logo = existing.logo;
        }
      }
    }
    const updated = await scoped.update(existing._id, {
      ...fields,
      version: existing.version,
    });
    return { branding: updated, changed: true, warnings };
  }
}

/** How many times `update` decides again after a concurrent write. */
const ATTEMPTS = 3;

function same(
  stored: StoredBrandingDoc,
  fields: {
    displayName: string;
    seed: string;
    radius: string;
    backgroundPreset: string | null;
    motif: string | null;
    css: string;
    logo: StoredLogo | null;
  },
) {
  return (
    stored.displayName === fields.displayName &&
    stored.seed === fields.seed &&
    stored.radius === fields.radius &&
    stored.backgroundPreset === fields.backgroundPreset &&
    stored.motif === fields.motif &&
    stored.css === fields.css &&
    stored.logo?.hash === fields.logo?.hash
  );
}
