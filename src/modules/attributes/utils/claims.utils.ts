import type { ObjectId } from "mongodb";
import type { RoleDoc } from "@/modules/roles";
import type { AttributeDoc } from "../attributes.types";
import type { ClaimValue } from "../claims.types";
import type { ValueDoc } from "../values.types";
import { matches } from "./values.utils";

/**
 * A stored value as a claim: a choice is its option key (an array for a
 * multiple choice), a DATE is `YYYY-MM-DD`, a DATETIME is RFC 3339, a number
 * and a boolean are native. `undefined` when the value does not fit its type.
 */
export function claimValue(
  attribute: AttributeDoc,
  value: ValueDoc["value"],
): ClaimValue | undefined {
  switch (attribute.type) {
    case "NUMBER":
      return typeof value === "number" ? value : undefined;
    case "BOOLEAN":
      return typeof value === "boolean" ? value : undefined;
    case "DATE":
      return value instanceof Date
        ? value.toISOString().slice(0, 10)
        : undefined;
    case "DATETIME":
      return value instanceof Date ? value.toISOString() : undefined;
    case "SELECT":
      return Array.isArray(value) && value.length === 1 ? value[0] : undefined;
    case "MULTI_SELECT":
      return Array.isArray(value) ? [...value] : undefined;
    default:
      return typeof value === "string" ? value : undefined;
  }
}

/**
 * Whether a held role puts the attribute on a token for the audience: a
 * tenant-wide role always does, a role of a resource only for a token whose
 * audience is that resource.
 */
export const roleApplies = (
  roles: readonly RoleDoc[],
  resourceId: ObjectId | null,
): boolean =>
  roles.some(
    (role) =>
      role.resourceId === null ||
      (resourceId !== null && role.resourceId.equals(resourceId)),
  );

/**
 * The claims of a user: each attribute of `emitted` (already narrowed to the
 * live ones whose scope the token holds) that has a value of its current
 * type, and, for the role family, a held role that applies (`applying`: the
 * attribute ids, in hex, that one does).
 */
export function claimsOf(
  emitted: readonly AttributeDoc[],
  values: readonly ValueDoc[],
  applying: ReadonlySet<string>,
): Record<string, ClaimValue> {
  const claims: Record<string, ClaimValue> = {};
  for (const attribute of emitted) {
    const id = attribute._id.toHexString();
    if (attribute.family === "ROLE" && !applying.has(id)) continue;
    const stored = values.find((value) =>
      value.attributeId.equals(attribute._id),
    );
    if (stored === undefined || !matches(stored, attribute)) continue;
    const claim = claimValue(attribute, stored.value);
    if (claim !== undefined) claims[attribute.key] = claim;
  }
  return claims;
}

/**
 * The scope table of the live attributes with an emission scope: each scope
 * to the claim keys it releases (sorted, so the discovery document is
 * stable). This is what an issuer's `scopeClaims` lists for the ID token,
 * userinfo and `claims_supported`.
 */
export function claimTable(
  attributes: readonly AttributeDoc[],
): Record<string, readonly string[]> {
  const table = new Map<string, string[]>();
  for (const attribute of attributes) {
    const scope = attribute.emission?.scope;
    if (scope === undefined) continue;
    table.set(scope, [...(table.get(scope) ?? []), attribute.key]);
  }
  return Object.fromEntries(
    [...table].map(([scope, keys]) => [scope, keys.sort()]),
  );
}
