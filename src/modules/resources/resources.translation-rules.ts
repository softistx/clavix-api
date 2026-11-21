import {
  canonicalLocale,
  localeKey,
  type Translation,
} from "@/shared/translations";
import { refuse } from "./resources.errors";

/** The most locales one text holds. */
export const MAX_TRANSLATIONS = 30;

/** What a caller sends for a text: a list of `{ locale, text }`, in any order. */
export type TranslationsInput = readonly Translation[] | null | undefined;

// The input as a map by locale key: trimmed, each locale once, each text bounded.
function entriesOf(
  input: readonly Translation[],
  max: number,
  what: string,
): Map<string, Translation> {
  const entries = new Map<string, Translation>();
  for (const item of input) {
    const locale = canonicalLocale(item.locale.trim());
    if (locale === undefined) {
      return refuse("a locale is not a language tag (BCP 47)");
    }
    if (entries.has(localeKey(locale))) {
      refuse(`${what} is given twice in ${locale}`);
    }
    const text = item.text.trim();
    if (text.length > max) refuse(`${what} has at most ${max} characters`);
    entries.set(localeKey(locale), { locale, text });
  }
  return entries;
}

function list(entries: Map<string, Translation>, what: string): Translation[] {
  const kept = [...entries.values()].filter((item) => item.text !== "");
  if (kept.length > MAX_TRANSLATIONS) {
    refuse(`${what} has at most ${MAX_TRANSLATIONS} languages`);
  }
  return kept;
}

/** A text as stored from what a caller wrote: each locale once, trimmed, a blank one left out. */
export function cleanTranslations(
  input: TranslationsInput,
  max: number,
  what: string,
): Translation[] {
  return list(entriesOf(input ?? [], max, what), what);
}

/**
 * A write over a stored text: the locales `input` names are set or replaced
 * (a blank text removes one), the others are kept. Nothing sent keeps it all.
 */
export function mergeTranslations(
  existing: readonly Translation[],
  input: TranslationsInput,
  max: number,
  what: string,
): Translation[] {
  if (input === undefined || input === null) return [...existing];
  const entries = new Map(
    existing.map((item) => [localeKey(item.locale), item]),
  );
  for (const [key, item] of entriesOf(input, max, what)) entries.set(key, item);
  return list(entries, what);
}

/** The text in one fixed order (by locale), to tell a real change from a repeat. */
export const canonTranslations = (texts: readonly Translation[]) =>
  texts
    .map((item) => [localeKey(item.locale), item.text])
    .sort(([a = ""], [b = ""]) => (a < b ? -1 : a > b ? 1 : 0));
