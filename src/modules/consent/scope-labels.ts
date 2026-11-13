import type { Description } from "@/modules/resources/catalog";

/** The texts of one scope of a tenant; `resource` is its resource's URI, `null` for a standard scope. */
export interface ScopeText {
  name: string;
  resource: string | null;
  description: Description;
}

/** A tenant's scope texts. */
export type ScopeTexts = readonly ScopeText[];

/** Reads the texts of the scopes of the tenant the request's host names (none for an unknown host). */
export type ScopeTextsFor = (request: Request) => Promise<ScopeTexts>;

export type ConsentLocale = "fr" | "en";

/** French when the first language the viewer prefers is French, else English. */
export function localeOf(acceptLanguage: string | null): ConsentLocale {
  const first = acceptLanguage?.split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("fr") ? "fr" : "en";
}

const inLocale = (description: Description, locale: ConsentLocale) => {
  const other = locale === "fr" ? "en" : "fr";
  return description[locale] !== ""
    ? description[locale]
    : description[other] !== ""
      ? description[other]
      : undefined;
};

/**
 * The text the consent page shows for a scope asked on `resource`: the
 * description of that resource's scope, else of the standard scope of that
 * name, in the viewer's language, else in the other one. `undefined` when the
 * tenant wrote none (the page then shows the scope's name).
 */
export function textOf(
  texts: ScopeTexts,
  scope: { name: string; resource: string },
  locale: ConsentLocale,
): string | undefined {
  const named = texts.filter((text) => text.name === scope.name);
  for (const owner of [scope.resource, null]) {
    const found = named.find((text) => text.resource === owner);
    const text =
      found === undefined ? undefined : inLocale(found.description, locale);
    if (text !== undefined) return text;
  }
  return undefined;
}
