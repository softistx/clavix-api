import type { FieldKind } from "@/modules/resources";
import type { ConsentLocale } from "./consent.scope-labels";

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

/** The details of a request in words, and whether every one is fully described. */
export interface ConsentDetails {
  details: ConsentDetail[];
  /**
   * False when a detail cannot be fully described: its type no longer exists,
   * it carries a key the type no longer defines (or an action or enum value
   * it no longer lists), or it is not a typed object. Approval is refused then.
   */
  complete: boolean;
}

const COMMON: Record<
  "actions" | "identifier" | "datatypes" | "locations",
  Text
> = {
  actions: { fr: "Actions", en: "Actions" },
  locations: { fr: "Emplacement", en: "Location" },
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

// RFC 9396 members the rows always show, whatever the type.
const COMMON_KEYS = new Set([
  "type",
  "locations",
  "actions",
  "identifier",
  "datatypes",
]);

// Whether the type's current definition describes every key and value of the detail.
function isComplete(
  detail: Record<string, unknown>,
  text: DetailText | undefined,
): boolean {
  if (text === undefined) return false;
  const keys = new Set(text.fields.map((field) => field.key));
  if (Object.keys(detail).some((k) => !COMMON_KEYS.has(k) && !keys.has(k)))
    return false;
  const actions = detail["actions"];
  if (
    Array.isArray(actions) &&
    actions.some((a) => !text.actions?.some((known) => known.value === a))
  )
    return false;
  return text.fields.every((field) => {
    const value = detail[field.key];
    if (field.kind !== "enum" || value === undefined || value === null)
      return true;
    return (Array.isArray(value) ? value : [value]).every((item) =>
      field.values?.some((v) => v.value === item),
    );
  });
}

function describe(
  detail: Record<string, unknown>,
  text: DetailText | undefined,
  locale: ConsentLocale,
): ConsentDetail {
  const type = String(detail["type"]);
  const rows: ConsentRow[] = [];
  const locations = detail["locations"];
  if (Array.isArray(locations) && locations.length > 0) {
    rows.push({
      label: pick(COMMON.locations, locale),
      value: locations.map(String).join(", "),
    });
  }
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
    const shown = formatted(value, field, locale);
    // An empty list, or a value of a shape the kind does not allow, has no row.
    if (shown === "") continue;
    rows.push({ label: pick(field.label, locale, field.key), value: shown });
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
 * the type's name and description, then its locations and actions, its fields
 * by their labels (an enum by the value's label, a boolean as yes/no, a number
 * in the viewer's format) and the RFC 9396 `identifier` and `datatypes`. No
 * raw JSON is shown. `complete` is false when a detail cannot be fully
 * described (a type the tenant no longer stores, a key, action or enum value
 * its definition no longer has, an entry that is not a typed object): what is
 * shown is then partial, and approval must be refused (R4, D4).
 */
export function reviewDetails(
  authorizationDetails: string | null,
  texts: DetailTexts,
  locale: ConsentLocale,
): ConsentDetails {
  if (authorizationDetails === null) return { details: [], complete: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(authorizationDetails);
  } catch {
    return { details: [], complete: false };
  }
  if (!Array.isArray(parsed)) return { details: [], complete: false };
  const typed = parsed
    .filter(isRecord)
    .filter((detail) => typeof detail["type"] === "string");
  const matches = typed.map((detail) => ({
    detail,
    text: texts.find((text) => text.type === detail["type"]),
  }));
  return {
    details: matches.map(({ detail, text }) => describe(detail, text, locale)),
    complete:
      typed.length === parsed.length &&
      matches.every(({ detail, text }) => isComplete(detail, text)),
  };
}

/** The details of a pending request in words (see `reviewDetails`). */
export const detailsOf = (
  authorizationDetails: string | null,
  texts: DetailTexts,
  locale: ConsentLocale,
): ConsentDetail[] =>
  reviewDetails(authorizationDetails, texts, locale).details;
