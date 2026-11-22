import { z } from "zod";

/** A text in one language: `locale` is a BCP 47 tag (RFC 5646), `text` is never blank once stored. */
export interface Translation {
  locale: string;
  text: string;
}

/** The stored shape of a text in several languages: at most one entry per locale. */
export const translationsSchema = z
  .array(z.object({ locale: z.string(), text: z.string() }))
  .default([]);

/** The tag in its canonical case (`fr-ca` becomes `fr-CA`), `undefined` when it is not a language tag. */
export function canonicalLocale(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
}

/** The key two spellings of one locale share. */
export const localeKey = (locale: string): string => locale.toLowerCase();

const languageOf = (locale: string): string =>
  localeKey(locale).split("-")[0] ?? "";

/**
 * The language tags of an `Accept-Language` header, the most wanted first
 * (by `q`, then in the order written): `*`, a zero `q` and what is not a
 * language tag are left out.
 */
export function acceptedLocales(header: string | null | undefined): string[] {
  const wanted = (header ?? "").split(",").flatMap((part, index) => {
    const [tag = "", ...params] = part.split(";").map((item) => item.trim());
    const quality = params
      .map((param) => /^q=([0-9.]+)$/i.exec(param)?.[1])
      .find((value) => value !== undefined);
    const weight = quality === undefined ? 1 : Number(quality);
    const locale = tag === "*" ? undefined : canonicalLocale(tag);
    return locale === undefined || !(weight > 0)
      ? []
      : [{ locale, weight, index }];
  });
  return wanted
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((item) => item.locale);
}

/**
 * The text shown to a viewer: for each language the viewer asks, in order, the
 * translation in exactly that locale, then in its base language (`fr` for
 * `fr-CA`), then a sibling region (`fr-FR` for `fr-CA`); else the first stored
 * translation. `undefined` when there is none.
 */
export function pickTranslation(
  translations: readonly Translation[],
  acceptLanguage: string | null | undefined,
): string | undefined {
  const usable = translations.filter((item) => item.text !== "");
  for (const asked of acceptedLocales(acceptLanguage)) {
    const language = languageOf(asked);
    const found =
      usable.find((item) => localeKey(item.locale) === localeKey(asked)) ??
      usable.find((item) => localeKey(item.locale) === language) ??
      usable.find((item) => languageOf(item.locale) === language);
    if (found !== undefined) return found.text;
  }
  return usable[0]?.text;
}
