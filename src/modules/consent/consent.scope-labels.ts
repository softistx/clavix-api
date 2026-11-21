import { pickTranslation, type Translation } from "@/shared/translations";

/** The texts of one scope of a tenant; `resource` is its resource's URI, `null` for a standard scope. */
export interface ScopeText {
  name: string;
  resource: string | null;
  description: readonly Translation[];
}

/** A tenant's scope texts. */
export type ScopeTexts = readonly ScopeText[];

/** Reads the texts of the scopes of the tenant the request's host names (none for an unknown host). */
export type ScopeTextsFor = (request: Request) => Promise<ScopeTexts>;

/**
 * The text the consent page shows for a scope asked on `resource`: the
 * description of that resource's scope, else of the standard scope of that
 * name, in the viewer's language (`Accept-Language`, then its base language,
 * then the first translation the tenant wrote). `undefined` when the tenant
 * wrote none (the page then shows the scope's name).
 */
export function textOf(
  texts: ScopeTexts,
  scope: { name: string; resource: string },
  acceptLanguage: string | null,
): string | undefined {
  const named = texts.filter((text) => text.name === scope.name);
  for (const owner of [scope.resource, null]) {
    const found = named.find((text) => text.resource === owner);
    const text =
      found === undefined
        ? undefined
        : pickTranslation(found.description, acceptLanguage);
    if (text !== undefined) return text;
  }
  return undefined;
}
