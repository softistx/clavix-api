import type { ObjectId } from "mongodb";
import type { RoleDoc } from "@/modules/roles";
import type {
  AttributeDoc,
  RoleAttributeDoc,
  RoleLink,
  RoleSection,
} from "../attributes.types";
import { byPosition } from "./attributes.utils";

/** A copy of the roles sorted by name. */
const byName = (found: readonly RoleDoc[]): RoleDoc[] =>
  [...found].sort((a, b) => a.name.localeCompare(b.name));

/** The links grouped by attribute id (hex), each with its role, sorted by role name; a link whose role is missing is left out. */
export function linksByAttribute(
  links: readonly RoleAttributeDoc[],
  roles: readonly RoleDoc[],
): Map<string, RoleLink[]> {
  const known = new Map(roles.map((role) => [role._id.toHexString(), role]));
  const grouped = new Map<string, RoleLink[]>();
  for (const link of links) {
    const role = known.get(link.roleId.toHexString());
    if (role === undefined) continue;
    const key = link.attributeId.toHexString();
    grouped.set(key, [
      ...(grouped.get(key) ?? []),
      { role, required: link.required },
    ]);
  }
  for (const [key, list] of grouped)
    grouped.set(
      key,
      [...list].sort((a, b) => a.role.name.localeCompare(b.role.name)),
    );
  return grouped;
}

/**
 * The role sections of one user: each held role that links at least one live
 * role-family attribute, by role name, its attributes by position with the
 * link's `required`. An archived attribute, or one of another family, is left
 * out (hidden), and so is a role with nothing left to show.
 */
export function roleSections(
  held: readonly RoleDoc[],
  links: readonly RoleAttributeDoc[],
  attributes: ReadonlyMap<string, AttributeDoc>,
): RoleSection[] {
  const sections: RoleSection[] = [];
  for (const role of byName(held)) {
    const required = new Map<string, boolean>();
    for (const link of links)
      if (link.roleId.equals(role._id))
        required.set(link.attributeId.toHexString(), link.required);
    const live = byPosition(
      [...required.keys()].flatMap((key) => {
        const attribute = attributes.get(key);
        return attribute !== undefined &&
          attribute.family === "ROLE" &&
          attribute.archivedAt === null
          ? [attribute]
          : [];
      }),
    );
    if (live.length === 0) continue;
    sections.push({
      role,
      items: live.map((attribute) => ({
        attribute,
        required: required.get(attribute._id.toHexString()) ?? false,
      })),
    });
  }
  return sections;
}

/** The held roles that link each attribute (hex), sorted by role name. */
export function heldLinking(
  held: readonly RoleDoc[],
  links: readonly RoleAttributeDoc[],
): Map<string, RoleDoc[]> {
  const grouped = new Map<string, RoleDoc[]>();
  for (const role of byName(held))
    for (const link of links) {
      if (!link.roleId.equals(role._id)) continue;
      const key = link.attributeId.toHexString();
      grouped.set(key, [...(grouped.get(key) ?? []), role]);
    }
  return grouped;
}

/** The ObjectIds of roles, without repeats. */
export function distinctIds(ids: readonly ObjectId[]): ObjectId[] {
  const seen = new Map(ids.map((id) => [id.toHexString(), id]));
  return [...seen.values()];
}

/** The attributes without repeats, in the order first seen. */
export function distinctAttributes(
  found: readonly AttributeDoc[],
): AttributeDoc[] {
  return [...new Map(found.map((a) => [a._id.toHexString(), a])).values()];
}
