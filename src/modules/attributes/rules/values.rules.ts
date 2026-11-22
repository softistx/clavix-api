import type { AttributeType, StoredValue } from "../attributes.model";
import { refuse } from "../attributes.refusals";
import type { AttributeDoc } from "../attributes.types";
import type { ValueInput } from "../values.types";

export const MAX_STRING = 200;
export const MAX_TEXT = 2000;
export const MAX_SELECTED = 100;
/** The changes one save may carry. */
export const MAX_CHANGES = 100;

/** The input field that carries each type. */
const FIELD_OF = {
  STRING: "text",
  TEXT: "text",
  COLOR: "color",
  NUMBER: "number",
  DATE: "date",
  DATETIME: "dateTime",
  TIME: "time",
  SELECT: "options",
  MULTI_SELECT: "options",
  BOOLEAN: "boolean",
} as const satisfies Record<AttributeType, keyof ValueInput>;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The field of `ValueInput` an attribute of this type is set through. */
export const fieldOf = (type: AttributeType): keyof ValueInput =>
  FIELD_OF[type];

const invalid = (index: number, message: string): never =>
  refuse("ATTRIBUTE_VALUE_INVALID", message, `values.${index}`);

/** The fields of the input that carry something. */
const given = (input: ValueInput): string[] =>
  Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([name]) => name);

function text(value: string, limit: number, index: number): string {
  const clean = value.normalize("NFC").trim();
  if (clean === "") return invalid(index, "a value cannot be blank");
  if (clean.length > limit)
    return invalid(index, `a value holds at most ${limit} characters`);
  return clean;
}

function day(value: string, index: number): Date {
  const parts = DAY.exec(value);
  const at = parts
    ? new Date(
        Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])),
      )
    : null;
  if (!parts || !at || at.toISOString().slice(0, 10) !== value)
    return invalid(index, `"${value}" is not a date (YYYY-MM-DD)`);
  return at;
}

function moment(value: Date | string, index: number): Date {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime()))
    return invalid(index, "the date and time is not valid");
  return at;
}

function clock(value: string, index: number): string {
  const parts = CLOCK.exec(value);
  if (!parts) return invalid(index, `"${value}" is not a time (HH:mm)`);
  return `${parts[1]}:${parts[2]}:${parts[3] ?? "00"}`;
}

function choice(
  attribute: AttributeDoc,
  keys: readonly string[],
  index: number,
): string[] {
  const known = new Set(attribute.options.map((o) => o.key));
  const picked = [...new Set(keys)];
  if (picked.length !== keys.length)
    return invalid(index, "an option is chosen twice");
  if (attribute.type === "SELECT" && picked.length !== 1)
    return invalid(index, "choose exactly one option");
  if (picked.length === 0) return invalid(index, "choose at least one option");
  if (picked.length > MAX_SELECTED)
    return invalid(index, `choose at most ${MAX_SELECTED} options`);
  const unknown = picked.find((key) => !known.has(key));
  if (unknown !== undefined)
    return invalid(index, `"${unknown}" is not an option of this attribute`);
  return picked;
}

/**
 * The value an attribute stores for `input`, canonical per type: the field of
 * its type must be the only one set, and valid. `index` names the value in the
 * refusal (`values.<index>`).
 */
export function canonicalValue(
  attribute: AttributeDoc,
  input: ValueInput,
  index: number,
): StoredValue {
  const field = fieldOf(attribute.type);
  const set = given(input);
  if (set.length !== 1 || set[0] !== field)
    return invalid(
      index,
      `a ${attribute.type} value is set through "${field}"`,
    );
  switch (attribute.type) {
    case "STRING":
      return text(input.text ?? "", MAX_STRING, index);
    case "TEXT":
      return text(input.text ?? "", MAX_TEXT, index);
    case "COLOR": {
      const color = input.color ?? "";
      if (!COLOR.test(color)) return invalid(index, "not a hex color");
      return color.toLowerCase();
    }
    case "NUMBER": {
      const n = input.number ?? Number.NaN;
      if (!Number.isFinite(n)) return invalid(index, "not a finite number");
      return Object.is(n, -0) ? 0 : n;
    }
    case "DATE":
      return day(input.date ?? "", index);
    case "DATETIME":
      return moment(input.dateTime ?? "", index);
    case "TIME":
      return clock(input.time ?? "", index);
    case "SELECT":
    case "MULTI_SELECT":
      return choice(attribute, input.options ?? [], index);
    case "BOOLEAN":
      return input.boolean === true;
  }
}

/**
 * The key a `unique` attribute's value is held unique by: the trimmed,
 * lower-cased text of a STRING, the canonical decimal of a NUMBER; `null` for
 * the other types (they cannot be unique) and for a non-string stored value.
 */
export function uniqueKeyOf(
  type: AttributeType,
  value: StoredValue,
): string | null {
  if (type === "STRING" && typeof value === "string")
    return value.normalize("NFC").trim().toLowerCase();
  if (type === "NUMBER" && typeof value === "number") return String(value);
  return null;
}

/** Whether a stored value is empty for the "required" check: no text left, nothing chosen. */
export const isEmpty = (value: StoredValue | undefined): boolean =>
  value === undefined ||
  (typeof value === "string" && value === "") ||
  (Array.isArray(value) && value.length === 0);
