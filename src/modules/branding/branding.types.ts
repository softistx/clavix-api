import type { TypedCollection } from "@softistx/mongo";
import type { StoredLogo } from "./branding.logo";
import type { branding } from "./branding.model";
import type { ThemeInput } from "./branding.theme";

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

/** The fields a brand stores, as `update` decides them. */
export interface BrandFields {
  displayName: string;
  seed: string;
  radius: string;
  backgroundPreset: string | null;
  motif: string | null;
  css: string;
  logo: StoredLogo | null;
}

/** What `tenantBranding` answers on the hosted pages. */
export interface PublicBranding {
  displayName: string;
  themeName: string;
  css: string;
  backgroundPreset: string | null;
  motif: string | null;
  logoUrl: string | null;
}
