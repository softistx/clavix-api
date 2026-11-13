import type { Description } from "@/modules/resources/catalog";

/** A tenant's scope texts by scope name, for the request's host. */
export type ScopeTexts = ReadonlyMap<string, Description>;

/** Reads the texts of the scopes of the tenant the request's host names (none for an unknown host). */
export type ScopeTextsFor = (request: Request) => Promise<ScopeTexts>;

export type ConsentLocale = "fr" | "en";

/** French when the first language the viewer prefers is French, else English. */
export function localeOf(acceptLanguage: string | null): ConsentLocale {
  const first = acceptLanguage?.split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("fr") ? "fr" : "en";
}

/**
 * The text the consent page shows for a scope: the tenant's description in the
 * viewer's language, else in the other one, else `undefined` (janus then shows
 * the scope's name).
 */
export function textOf(
  texts: ScopeTexts,
  name: string,
  locale: ConsentLocale,
): string | undefined {
  const found = texts.get(name);
  if (found === undefined) return undefined;
  const other = locale === "fr" ? "en" : "fr";
  return found[locale] !== ""
    ? found[locale]
    : found[other] !== ""
      ? found[other]
      : undefined;
}
