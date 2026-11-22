import type { ObjectId } from "mongodb";
import type { AttributeDoc, AttributeFields } from "./attributes.types";

/** The gap under which a move renumbers the family: two floats too close to split again. */
export const MIN_GAP = 1e-6;

/** The step between positions when a family is numbered afresh. */
export const STEP = 1000;

/** A copy of the attributes sorted by position, then key. */
export function byPosition(found: readonly AttributeDoc[]): AttributeDoc[] {
  return [...found].sort(
    (a, b) => a.position - b.position || a.key.localeCompare(b.key),
  );
}

/** The position after the last of `found`, `STEP` for an empty family. */
export function positionAfter(found: readonly AttributeDoc[]): number {
  return found.reduce((max, a) => Math.max(max, a.position), 0) + STEP;
}

/**
 * The position that puts a document at `index` among `others` (the live
 * attributes of its family without it, sorted): half way between its two
 * neighbours. `null` when the neighbours are too close to split: the family
 * is renumbered first.
 */
export function positionAt(
  others: readonly AttributeDoc[],
  index: number,
): number | null {
  const at = Math.min(Math.max(index, 0), others.length);
  const before = others[at - 1]?.position;
  const after = others[at]?.position;
  if (before === undefined && after === undefined) return STEP;
  if (before === undefined) return (after ?? 0) - STEP;
  if (after === undefined) return before + STEP;
  return after - before < MIN_GAP ? null : (before + after) / 2;
}

/** What the console shows of an attribute, with how many values it holds. */
export const shape = (attribute: AttributeDoc, valueCount: number) => ({
  id: attribute._id.toHexString(),
  key: attribute.key,
  family: attribute.family,
  type: attribute.type,
  label: attribute.label,
  description: attribute.description,
  unit: attribute.unit,
  options: attribute.options,
  required: attribute.required,
  userEditable: attribute.userEditable,
  unique: attribute.unique,
  emissionScope: attribute.emission?.scope ?? null,
  archivedAt: attribute.archivedAt,
  valueCount,
  // The role links are slice A3's: no attribute is linked to a role yet.
  roles: [],
  version: attribute.version,
});

/** What an admin event names: the attribute id and its tenant. */
export const target = (id: string, tenantId: string) => ({
  type: "userAttribute",
  id,
  tenantId,
});

/** The ObjectIds of attributes, for a grouped count. */
export const idsOf = (found: readonly AttributeDoc[]): ObjectId[] =>
  found.map((attribute) => attribute._id);

/** The settings of an attribute that an update can change. */
export const fieldsOf = (attribute: AttributeDoc): AttributeFields => ({
  type: attribute.type,
  label: attribute.label,
  description: attribute.description,
  unit: attribute.unit,
  options: attribute.options,
  required: attribute.required,
  userEditable: attribute.userEditable,
  unique: attribute.unique,
  emission: attribute.emission,
});
