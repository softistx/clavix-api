import type { AttributeType, StoredValue } from "../attributes.model";
import type { AttributeDoc } from "../attributes.types";
import type { ExportedValue, ShownValue, ValueDoc } from "../values.types";
import { shape } from "./attributes.utils";

const NONE = {
  text: null,
  color: null,
  number: null,
  boolean: null,
  date: null,
  dateTime: null,
  time: null,
  options: null,
} as const;

/** A stored value matches its attribute while the type it was written under is the attribute's (risk 3). */
export const matches = (value: ValueDoc, attribute: AttributeDoc): boolean =>
  value.type === attribute.type;

/** The stored values grouped by user id. */
export function byUser(found: readonly ValueDoc[]): Map<string, ValueDoc[]> {
  const grouped = new Map<string, ValueDoc[]>();
  for (const value of found) {
    const list = grouped.get(value.userId) ?? [];
    list.push(value);
    grouped.set(value.userId, list);
  }
  return grouped;
}

/** The typed field that holds a stored value, every other field null. */
export function valueFields(
  type: AttributeType,
  value: StoredValue,
): Omit<ShownValue, "attributeId"> {
  switch (type) {
    case "STRING":
    case "TEXT":
      return { ...NONE, text: typeof value === "string" ? value : null };
    case "COLOR":
      return { ...NONE, color: typeof value === "string" ? value : null };
    case "TIME":
      return { ...NONE, time: typeof value === "string" ? value : null };
    case "NUMBER":
      return { ...NONE, number: typeof value === "number" ? value : null };
    case "BOOLEAN":
      return { ...NONE, boolean: typeof value === "boolean" ? value : null };
    case "DATE":
      return {
        ...NONE,
        date: value instanceof Date ? value.toISOString().slice(0, 10) : null,
      };
    case "DATETIME":
      return { ...NONE, dateTime: value instanceof Date ? value : null };
    case "SELECT":
    case "MULTI_SELECT":
      return { ...NONE, options: Array.isArray(value) ? [...value] : null };
  }
}

/**
 * What the console shows of an attribute for a user: the typed field that
 * holds the value, every other field null. A missing value, or one written
 * under another type, shows empty.
 */
export function shown(
  attribute: AttributeDoc,
  value: ValueDoc | undefined,
): ShownValue {
  const attributeId = attribute._id.toHexString();
  if (value === undefined || !matches(value, attribute))
    return { attributeId, ...NONE };
  return { attributeId, ...valueFields(attribute.type, value.value) };
}

/** An attribute of a user's section with its value, as the console's `AttributeValue`. */
export function attributeValueView(
  attribute: AttributeDoc,
  valueCount: number,
  value: ValueDoc | undefined,
) {
  const { attributeId: _, ...fields } = shown(attribute, value);
  return { attribute: shape(attribute, valueCount), ...fields };
}

/** An exported value as the console's `ExportedAttributeValue`. */
export const exportedView = (item: ExportedValue) => ({
  key: item.key,
  label: item.label.map((text) => ({ ...text })),
  hidden: item.hidden,
  roles: item.roles,
  updatedAt: item.updatedAt,
  ...valueFields(item.type, item.value),
});
