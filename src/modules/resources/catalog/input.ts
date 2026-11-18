import type { ReadDocumentOf } from "@softistx/mongo";
import { CatalogError } from "../catalog.errors";
import type { detailTypes } from "../detail-types/detail-types.model";
import type { resources } from "../resources.model";
import type { scopes } from "../scopes.model";

export type StoredResourceDoc = ReadDocumentOf<typeof resources>;
export type StoredScopeDoc = ReadDocumentOf<typeof scopes>;
export type StoredDetailTypeDoc = ReadDocumentOf<typeof detailTypes>;

export interface Description {
  fr: string;
  en: string;
}

/** A text to set; a language left out (or `undefined`) is not touched. */
export interface DescriptionInput {
  fr?: string | undefined;
  en?: string | undefined;
}

export interface ScopeInput {
  name: string;
  description?: DescriptionInput | undefined;
  /** The resource it belongs to; `null` for a standard OpenID Connect scope. */
  resourceId?: string | null | undefined;
  claims?: readonly string[] | undefined;
}

export const MAX_NAME = 100;
export const MAX_DESCRIPTION = 300;
/** The longest label (a type or a field name, an enum value or an action label). */
export const MAX_LABEL = 100;
const MAX_CLAIMS = 50;

function refuse(message: string): never {
  throw new CatalogError("BAD_USER_INPUT", message);
}

export function cleanClaims(claims: readonly string[] | undefined) {
  const clean = [...new Set((claims ?? []).map((claim) => claim.trim()))];
  if (clean.length > MAX_CLAIMS || clean.some((c) => c.length > MAX_NAME)) {
    refuse(
      `a scope has at most ${MAX_CLAIMS} claims of ${MAX_NAME} characters`,
    );
  }
  return clean;
}

export function cleanText(text: string | undefined): string | undefined {
  const clean = text?.trim();
  if ((clean?.length ?? 0) > MAX_DESCRIPTION) {
    refuse(`a description has at most ${MAX_DESCRIPTION} characters`);
  }
  return clean;
}

export function cleanName(name: string): string {
  const clean = name.trim();
  if (clean === "") refuse("a resource needs a name");
  if (clean.length > MAX_NAME) {
    refuse(`a name has at most ${MAX_NAME} characters`);
  }
  return clean;
}
