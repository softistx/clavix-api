import type { FieldKind } from "@/modules/resources";
import { pickTranslation, type Translation } from "@/shared/translations";

type Text = readonly Translation[];

/** What the formatting reads of a field. */
export interface FormattedField {
  kind: FieldKind;
  values?: readonly { value: string; label: Text }[] | undefined;
}

/**
 * One value of a row, typed and never worded: a text (a tenant's own words
 * in the viewer's language, or a raw string), a number or a boolean. The page
 * words and formats numbers and booleans itself, from its own catalogue.
 */
export type ConsentValue =
  | { kind: "text"; text: string }
  | { kind: "number"; number: number }
  | { kind: "boolean"; boolean: boolean };

// The viewer's language (see `pickTranslation`), else `fallback`.
export const pick = (
  text: Text | undefined,
  acceptLanguage: string | null,
  fallback = "",
) => pickTranslation(text ?? [], acceptLanguage) ?? fallback;

const text = (value: string): ConsentValue => ({ kind: "text", text: value });

function scalar(value: unknown): ConsentValue[] {
  if (typeof value === "boolean") return [{ kind: "boolean", boolean: value }];
  if (typeof value === "number") return [{ kind: "number", number: value }];
  return typeof value === "string" && value !== "" ? [text(value)] : [];
}

/** The values of a field's detail, one per item of a list, none when the shape does not fit. */
export function valuesOf(
  value: unknown,
  field: FormattedField,
  acceptLanguage: string | null,
): ConsentValue[] {
  const labelOf = (raw: string) =>
    text(
      pick(
        field.values?.find((v) => v.value === raw)?.label,
        acceptLanguage,
        raw,
      ),
    );
  const one = (item: unknown): ConsentValue[] =>
    field.kind === "enum" ? [labelOf(String(item))] : scalar(item);
  if (Array.isArray(value)) return value.flatMap(one);
  return field.kind === "enum" && typeof value !== "string" ? [] : one(value);
}
