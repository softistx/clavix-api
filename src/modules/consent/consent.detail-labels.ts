import type { FieldKind } from "@/modules/resources";
import type { Translation } from "@/shared/translations";
import { isRecord } from "@/shared/values";
import { COMMON, formatted, pick } from "./consent.detail-format";

type Text = readonly Translation[];

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
  acceptLanguage: string | null,
): ConsentDetail {
  const type = String(detail["type"]);
  const rows: ConsentRow[] = [];
  const locations = detail["locations"];
  if (Array.isArray(locations) && locations.length > 0) {
    rows.push({
      label: pick(COMMON.locations, acceptLanguage),
      value: locations.map(String).join(", "),
    });
  }
  const actions = detail["actions"];
  if (Array.isArray(actions) && actions.length > 0) {
    rows.push({
      label: pick(COMMON.actions, acceptLanguage),
      value: actions
        .map((action) =>
          pick(
            text?.actions?.find((a) => a.value === action)?.label,
            acceptLanguage,
            String(action),
          ),
        )
        .join(", "),
    });
  }
  for (const field of text?.fields ?? []) {
    const value = detail[field.key];
    if (value === undefined || value === null) continue;
    const shown = formatted(value, field, acceptLanguage);
    // An empty list, or a value of a shape the kind does not allow, has no row.
    if (shown === "") continue;
    rows.push({
      label: pick(field.label, acceptLanguage, field.key),
      value: shown,
    });
  }
  const identifier = detail["identifier"];
  if (typeof identifier === "string") {
    rows.push({
      label: pick(COMMON.identifier, acceptLanguage),
      value: identifier,
    });
  }
  const datatypes = detail["datatypes"];
  if (Array.isArray(datatypes) && datatypes.length > 0) {
    rows.push({
      label: pick(COMMON.datatypes, acceptLanguage),
      value: datatypes.map(String).join(", "),
    });
  }
  return {
    type,
    title: pick(text?.name, acceptLanguage, type),
    description: pick(text?.description, acceptLanguage),
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
  acceptLanguage: string | null,
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
    details: matches.map(({ detail, text }) =>
      describe(detail, text, acceptLanguage),
    ),
    complete:
      typed.length === parsed.length &&
      matches.every(({ detail, text }) => isComplete(detail, text)),
  };
}

/** The details of a pending request in words (see `reviewDetails`). */
export const detailsOf = (
  authorizationDetails: string | null,
  texts: DetailTexts,
  acceptLanguage: string | null,
): ConsentDetail[] =>
  reviewDetails(authorizationDetails, texts, acceptLanguage).details;
