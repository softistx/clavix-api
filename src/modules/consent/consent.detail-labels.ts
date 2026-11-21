import type { ConsentRowKind } from "@/generated/graphql/resolvers";
import type { FieldKind } from "@/modules/resources";
import type { Translation } from "@/shared/translations";
import { isRecord } from "@/shared/values";
import { type ConsentValue, pick, valuesOf } from "./consent.detail-format";

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

/**
 * One line of a detail block. `kind` is a stable code the page words from its
 * own catalogue (locations, actions, identifier, datatypes); a `field` row
 * carries its `key` and the tenant's `label`. Values are typed, never worded.
 */
export interface ConsentRow {
  kind: ConsentRowKind;
  key: string | null;
  label: string | null;
  values: ConsentValue[];
}

/** One authorization detail of a pending request as typed rows (D5): never the raw JSON. */
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
  const row = (
    kind: ConsentRowKind,
    values: ConsentValue[],
    key: string | null = null,
    label: string | null = null,
  ) => {
    // An empty list, or a value of a shape the kind does not allow, has no row.
    if (values.length > 0) rows.push({ kind, key, label, values });
  };
  const strings = (items: unknown): ConsentValue[] =>
    Array.isArray(items)
      ? items.map((item) => ({ kind: "text", text: String(item) }))
      : [];
  row("locations", strings(detail["locations"]));
  const actions = detail["actions"];
  row(
    "actions",
    Array.isArray(actions)
      ? actions.map((action) => ({
          kind: "text",
          text: pick(
            text?.actions?.find((a) => a.value === action)?.label,
            acceptLanguage,
            String(action),
          ),
        }))
      : [],
  );
  for (const field of text?.fields ?? []) {
    const value = detail[field.key];
    if (value === undefined || value === null) continue;
    row(
      "field",
      valuesOf(value, field, acceptLanguage),
      field.key,
      pick(field.label, acceptLanguage, field.key),
    );
  }
  const identifier = detail["identifier"];
  if (typeof identifier === "string") {
    row("identifier", [{ kind: "text", text: identifier }]);
  }
  row("datatypes", strings(detail["datatypes"]));
  return {
    type,
    title: pick(text?.name, acceptLanguage, type),
    description: pick(text?.description, acceptLanguage),
    rows,
  };
}

/**
 * The details of a pending request (janus's `authorizationDetails`, a JSON
 * array string) as blocks of rows with a stable kind and typed values (D5):
 * the type's name and description (the tenant's words, in the viewer's
 * language), then its locations and actions, its fields by the tenant's labels
 * (an enum by the value's label; a boolean and a number stay raw for the page
 * to word and format) and the RFC 9396 `identifier` and `datatypes`. No
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
