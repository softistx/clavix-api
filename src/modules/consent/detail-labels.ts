import type { FieldKind } from "@/modules/resources/detail-types/detail-types.model";
import type { ConsentLocale } from "./scope-labels";

type Text = { fr: string; en: string };

/** The words of one detail type of a tenant (D5): what the consent page shows of it. */
export interface DetailText {
  type: string;
  name: Text;
  description: Text;
  fields: readonly {
    key: string;
    kind: FieldKind;
    label: Text;
    values?: readonly { value: string; label: Text }[] | undefined;
  }[];
  actions?: readonly { value: string; label: Text }[] | undefined;
}

/** A tenant's detail type texts. */
export type DetailTexts = readonly DetailText[];

/** Reads the detail type texts of the tenant the request's host names (none for an unknown host). */
export type DetailTextsFor = (request: Request) => Promise<DetailTexts>;

/** One line of a detail block: a label and the value in words. */
export interface ConsentRow {
  label: string;
  value: string;
}

/** One authorization detail of a pending request, in words (D5): never the raw JSON. */
export interface ConsentDetail {
  type: string;
  title: string;
  description: string;
  rows: ConsentRow[];
}

const COMMON: Record<"actions" | "identifier" | "datatypes", Text> = {
  actions: { fr: "Actions", en: "Actions" },
  identifier: { fr: "Identifiant", en: "Identifier" },
  datatypes: { fr: "Données", en: "Data" },
};
const YES_NO: Record<ConsentLocale, [string, string]> = {
  fr: ["Oui", "Non"],
  en: ["Yes", "No"],
};

// The viewer's language, else the other one, else `fallback`.
function pick(text: Text | undefined, locale: ConsentLocale, fallback = "") {
  if (text === undefined) return fallback;
  const other = locale === "fr" ? "en" : "fr";
  return text[locale] !== ""
    ? text[locale]
    : text[other] !== ""
      ? text[other]
      : fallback;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function scalar(value: unknown, locale: ConsentLocale): string {
  if (typeof value === "boolean") return YES_NO[locale][value ? 0 : 1];
  if (typeof value === "number")
    return new Intl.NumberFormat(locale).format(value);
  return typeof value === "string" ? value : "";
}

function formatted(
  value: unknown,
  field: DetailText["fields"][number],
  locale: ConsentLocale,
): string {
  const labelOf = (raw: string) =>
    pick(field.values?.find((v) => v.value === raw)?.label, locale, raw);
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        field.kind === "enum" ? labelOf(String(item)) : scalar(item, locale),
      )
      .join(", ");
  }
  return field.kind === "enum" && typeof value === "string"
    ? labelOf(value)
    : scalar(value, locale);
}

function describe(
  detail: Record<string, unknown>,
  text: DetailText | undefined,
  locale: ConsentLocale,
): ConsentDetail {
  const type = String(detail["type"]);
  const rows: ConsentRow[] = [];
  const actions = detail["actions"];
  if (Array.isArray(actions) && actions.length > 0) {
    rows.push({
      label: pick(COMMON.actions, locale),
      value: actions
        .map((action) =>
          pick(
            text?.actions?.find((a) => a.value === action)?.label,
            locale,
            String(action),
          ),
        )
        .join(", "),
    });
  }
  for (const field of text?.fields ?? []) {
    const value = detail[field.key];
    if (value === undefined || value === null) continue;
    rows.push({
      label: pick(field.label, locale, field.key),
      value: formatted(value, field, locale),
    });
  }
  const identifier = detail["identifier"];
  if (typeof identifier === "string") {
    rows.push({ label: pick(COMMON.identifier, locale), value: identifier });
  }
  const datatypes = detail["datatypes"];
  if (Array.isArray(datatypes) && datatypes.length > 0) {
    rows.push({
      label: pick(COMMON.datatypes, locale),
      value: datatypes.map(String).join(", "),
    });
  }
  return {
    type,
    title: pick(text?.name, locale, type),
    description: pick(text?.description, locale),
    rows,
  };
}

/**
 * The details of a pending request (janus's `authorizationDetails`, a JSON
 * array string) as blocks of label/value rows in the viewer's language (D5):
 * the type's name and description, then its actions, its fields by their
 * labels (an enum by the value's label, a boolean as yes/no, a number in the
 * viewer's format) and the RFC 9396 `identifier` and `datatypes`. A type the
 * tenant no longer stores shows its name and what the common fields hold;
 * a field the definition does not know is never shown, and no raw JSON is.
 */
export function detailsOf(
  authorizationDetails: string | null,
  texts: DetailTexts,
  locale: ConsentLocale,
): ConsentDetail[] {
  if (authorizationDetails === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(authorizationDetails);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(isRecord)
    .filter((detail) => typeof detail["type"] === "string")
    .map((detail) =>
      describe(
        detail,
        texts.find((text) => text.type === detail["type"]),
        locale,
      ),
    );
}
