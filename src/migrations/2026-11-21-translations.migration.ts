import { defineMigration } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { isRecord } from "@/shared/values";

export const id = "2026-11-21-translations";

// The shape this migration reads and writes back: the two languages the
// texts were stored in before they became a list of locales. English first,
// so a viewer whose languages the tenant did not write sees English still.
const LEGACY_LOCALES = ["en", "fr"] as const;

type Rewrite = (text: unknown) => unknown;

/** `{ fr, en }` as a list of translations (a blank language left out); a list stays as it is. */
const toList: Rewrite = (text) => {
  if (!isRecord(text)) return text;
  return LEGACY_LOCALES.flatMap((locale) => {
    const value = text[locale];
    return typeof value === "string" && value.trim() !== ""
      ? [{ locale, text: value }]
      : [];
  });
};

/** A list of translations as `{ fr, en }`; the other locales are lost. */
const toLegacy: Rewrite = (text) => {
  if (!Array.isArray(text)) return text;
  const textIn = (locale: string) => {
    const found = text.find(
      (item) => isRecord(item) && item["locale"] === locale,
    );
    return isRecord(found) && typeof found["text"] === "string"
      ? found["text"]
      : "";
  };
  return { fr: textIn("fr"), en: textIn("en") };
};

const rewriteLabels = (items: unknown, rewrite: Rewrite): unknown =>
  Array.isArray(items)
    ? items.map((item) =>
        isRecord(item) ? { ...item, label: rewrite(item["label"]) } : item,
      )
    : items;

/** A detail type document with every text of it rewritten. */
function rewriteDetailType(doc: Record<string, unknown>, rewrite: Rewrite) {
  const fields = Array.isArray(doc["fields"])
    ? doc["fields"].map((field) =>
        isRecord(field)
          ? {
              ...field,
              label: rewrite(field["label"]),
              ...(field["values"] === undefined
                ? {}
                : { values: rewriteLabels(field["values"], rewrite) }),
            }
          : field,
      )
    : doc["fields"];
  return {
    name: rewrite(doc["name"]),
    description: rewrite(doc["description"]),
    fields,
    ...(doc["actions"] === undefined
      ? {}
      : { actions: rewriteLabels(doc["actions"], rewrite) }),
  };
}

// `down` writes the old shape, which the new validator refuses.
const BYPASS = { bypassDocumentValidation: true } as const;

async function rewriteAll(db: Db, rewrite: Rewrite): Promise<void> {
  const scopes = db.collection("scopes");
  for await (const scope of scopes.find()) {
    const description = rewrite(scope["description"]);
    if (JSON.stringify(description) === JSON.stringify(scope["description"])) {
      continue;
    }
    await scopes.updateOne(
      { _id: scope._id },
      { $set: { description } },
      BYPASS,
    );
  }
  const types = db.collection("detailTypes");
  for await (const type of types.find()) {
    const next = rewriteDetailType(type, rewrite);
    const same = Object.entries(next).every(
      ([key, value]) => JSON.stringify(value) === JSON.stringify(type[key]),
    );
    if (!same) await types.updateOne({ _id: type._id }, { $set: next }, BYPASS);
  }
}

/**
 * Scope descriptions and detail type texts (names, descriptions, field,
 * value and action labels) were `{ fr, en }`; they are lists of
 * `{ locale, text }` now (#484). A blank language is left out. It moves
 * neither `version` nor `updatedAt`. Run `db:sync` first (the validator).
 * Idempotent: a text already a list is left alone.
 */
export const translationsMigration = defineMigration({
  id,
  async up({ db }) {
    await rewriteAll(db, toList);
  },
  // Only `fr` and `en` fit the old shape: the other locales are lost.
  async down({ db }) {
    await rewriteAll(db, toLegacy);
  },
});
