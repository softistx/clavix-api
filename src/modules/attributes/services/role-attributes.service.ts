import { ConflictError, scopeToTenant } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { RoleDoc } from "@/modules/roles";
import { refuse, refuseCommon } from "../attributes.refusals";
import type {
  AttributeDoc,
  AttributeRoleLinks,
  HeldRoleLinks,
  RoleAttributeDoc,
  RoleLink,
  RoleSection,
} from "../attributes.types";
import type { RoleAttributesOptions } from "../role-attributes.types";
import {
  distinctIds,
  heldLinking,
  linksByAttribute,
  roleSections,
} from "../utils";

/**
 * The links between role-family attributes and roles (user-attributes slice
 * A3). Every method takes the tenant's id and reads and writes through its
 * scope. A link names one precise role (a role is per tenant and per
 * resource). Assigning is idempotent, unassigning too; a link removed, or a
 * role unassigned from a user, writes no value: hiding is computed at read.
 * The links of a deleted role and of a deleted attribute are swept by the
 * `RoleLinks` and `AttributeRoleLinks` ports.
 */
export class RoleAttributesService
  implements AttributeRoleLinks, HeldRoleLinks
{
  constructor(private readonly options: RoleAttributesOptions) {}

  private own(tenantId: ObjectId) {
    return scopeToTenant(this.options.links, tenantId);
  }

  private catalogue(tenantId: ObjectId) {
    return scopeToTenant(this.options.attributes, tenantId);
  }

  private rolesOf(tenantId: ObjectId) {
    return scopeToTenant(this.options.roles, tenantId);
  }

  private assignmentsOf(tenantId: ObjectId) {
    return scopeToTenant(this.options.assignments, tenantId);
  }

  // The ports of the roles and of the catalogue.

  async removeForRole(tenantId: ObjectId, roleId: ObjectId): Promise<void> {
    await this.own(tenantId).hardDeleteMany({ roleId });
  }

  async removeForAttribute(
    tenantId: ObjectId,
    attributeId: ObjectId,
  ): Promise<void> {
    await this.own(tenantId).hardDeleteMany({ attributeId });
  }

  async heldBy(
    tenantId: ObjectId,
    userId: string,
  ): Promise<Map<string, RoleDoc[]>> {
    const { held, links } = await this.heldOf(tenantId, [userId]);
    return heldLinking(held.get(userId) ?? [], links);
  }

  // The links.

  private async findRole(tenantId: ObjectId, roleId: string) {
    const found = ObjectId.isValid(roleId)
      ? await this.rolesOf(tenantId).findById(new ObjectId(roleId))
      : undefined;
    if (found === undefined)
      return refuseCommon("NOT_FOUND", "No such role", "roleId");
    return found;
  }

  private async findAttribute(tenantId: ObjectId, attributeId: string) {
    const found = ObjectId.isValid(attributeId)
      ? await this.catalogue(tenantId).findById(new ObjectId(attributeId))
      : undefined;
    if (found === undefined)
      return refuseCommon("NOT_FOUND", "No such attribute", "attributeId");
    return found;
  }

  /**
   * Links the role-family attribute to the role, `required` for this role
   * only, and returns the attribute. A repeat sets `required` and changes
   * nothing else. `NOT_FOUND` for an unknown role or attribute,
   * `ATTRIBUTE_FAMILY_MISMATCH` for a user-family attribute and
   * `ATTRIBUTE_ARCHIVED` for an archived one.
   */
  async assign(
    tenantId: ObjectId,
    roleId: string,
    attributeId: string,
    required: boolean,
  ): Promise<AttributeDoc> {
    const role = await this.findRole(tenantId, roleId);
    const attribute = await this.findAttribute(tenantId, attributeId);
    if (attribute.family !== "ROLE")
      refuse(
        "ATTRIBUTE_FAMILY_MISMATCH",
        "only a role attribute can be linked to a role",
        "attributeId",
      );
    if (attribute.archivedAt !== null)
      refuse("ATTRIBUTE_ARCHIVED", "the attribute is archived", "attributeId");
    const own = this.own(tenantId);
    const filter = { roleId: role._id, attributeId: attribute._id };
    let link = await own.findFirst(filter);
    if (link === undefined) {
      try {
        link = await own.create({ ...filter, required });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        link = await own.findFirst(filter);
      }
    }
    if (link !== undefined && link.required !== required)
      await own.update(link._id, { required });
    // The role or the attribute may have gone between the checks and the
    // write (a `deleteRole`, a permanent delete): leave no link to either.
    const stillThere =
      (await this.rolesOf(tenantId).findById(role._id)) !== undefined &&
      (await this.catalogue(tenantId).findById(attribute._id)) !== undefined;
    if (!stillThere) {
      await own.hardDeleteMany(filter);
      return refuseCommon("NOT_FOUND", "No such role or attribute");
    }
    return attribute;
  }

  /** Changes the `required` of an existing link and returns the attribute. `NOT_FOUND` when the role is not linked to it. */
  async update(
    tenantId: ObjectId,
    roleId: string,
    attributeId: string,
    required: boolean,
  ): Promise<AttributeDoc> {
    const role = await this.findRole(tenantId, roleId);
    const attribute = await this.findAttribute(tenantId, attributeId);
    const own = this.own(tenantId);
    const link = await own.findFirst({
      roleId: role._id,
      attributeId: attribute._id,
    });
    if (link === undefined)
      return refuseCommon(
        "NOT_FOUND",
        "The attribute is not linked to this role",
        "attributeId",
      );
    if (link.required !== required) await own.update(link._id, { required });
    return attribute;
  }

  /** Removes the link; `true` when there was one. The users' values stay (hidden); nothing else is written. */
  async unassign(
    tenantId: ObjectId,
    roleId: string,
    attributeId: string,
  ): Promise<boolean> {
    if (!ObjectId.isValid(roleId) || !ObjectId.isValid(attributeId))
      return false;
    const removed = await this.own(tenantId).hardDeleteMany({
      roleId: new ObjectId(roleId),
      attributeId: new ObjectId(attributeId),
    });
    return removed > 0;
  }

  // Reads.

  /** The roles each of the attributes is linked to, by attribute id (hex), sorted by role name. */
  async linksOf(
    tenantId: ObjectId,
    attributes: readonly AttributeDoc[],
  ): Promise<Map<string, RoleLink[]>> {
    const ids = attributes
      .filter((attribute) => attribute.family === "ROLE")
      .map((attribute) => attribute._id);
    if (ids.length === 0) return new Map();
    const links = await this.own(tenantId).findMany({
      filter: { attributeId: { $in: ids } },
    });
    const roles = await this.rolesOf(tenantId).findMany({
      filter: { _id: { $in: distinctIds(links.map((link) => link.roleId)) } },
    });
    return linksByAttribute(links, roles);
  }

  /** The roles of each user (by user id) and the links of those roles. */
  private async heldOf(tenantId: ObjectId, userIds: readonly string[]) {
    const assignments = await this.assignmentsOf(tenantId).findMany({
      filter: { userId: { $in: [...userIds] } },
    });
    const roles: RoleDoc[] =
      assignments.length === 0
        ? []
        : await this.rolesOf(tenantId).findMany({
            filter: {
              _id: { $in: distinctIds(assignments.map((a) => a.roleId)) },
            },
          });
    const known = new Map(roles.map((role) => [role._id.toHexString(), role]));
    const held = new Map<string, RoleDoc[]>();
    for (const assignment of assignments) {
      const role = known.get(assignment.roleId.toHexString());
      if (role === undefined) continue;
      held.set(assignment.userId, [
        ...(held.get(assignment.userId) ?? []),
        role,
      ]);
    }
    const links: RoleAttributeDoc[] =
      roles.length === 0
        ? []
        : await this.own(tenantId).findMany({
            filter: { roleId: { $in: roles.map((role) => role._id) } },
          });
    return { held, links };
  }

  /**
   * The role sections of the users, by user id: each held role that links a
   * live role attribute (see `roleSections`). A user with none has no entry.
   */
  async sectionsOf(
    tenantId: ObjectId,
    userIds: readonly string[],
  ): Promise<Map<string, RoleSection[]>> {
    const sections = new Map<string, RoleSection[]>();
    if (userIds.length === 0) return sections;
    const { held, links } = await this.heldOf(tenantId, userIds);
    if (links.length === 0) return sections;
    const found = await this.catalogue(tenantId).findMany({
      filter: {
        _id: { $in: distinctIds(links.map((link) => link.attributeId)) },
      },
    });
    const attributes = new Map(found.map((a) => [a._id.toHexString(), a]));
    for (const [userId, roles] of held) {
      const own = roleSections(roles, links, attributes);
      if (own.length > 0) sections.set(userId, own);
    }
    return sections;
  }

  /**
   * The links of a role the user holds (attribute id in hex, the link's
   * `required`), to check a role section's save. `ATTRIBUTE_ROLE_NOT_HELD`
   * when the user does not hold the role (or the role is gone). Called under
   * the user's lock.
   */
  async linksHeld(
    tenantId: ObjectId,
    userId: string,
    roleId: string,
  ): Promise<Map<string, boolean>> {
    const field = "section.roleId";
    const held = ObjectId.isValid(roleId)
      ? await this.assignmentsOf(tenantId).findFirst({
          roleId: new ObjectId(roleId),
          userId,
        })
      : undefined;
    const role =
      held === undefined
        ? undefined
        : await this.rolesOf(tenantId).findById(held.roleId);
    if (held === undefined || role === undefined)
      return refuse(
        "ATTRIBUTE_ROLE_NOT_HELD",
        "The user does not hold this role",
        field,
      );
    const links = await this.own(tenantId).findMany({
      filter: { roleId: role._id },
    });
    return new Map(
      links.map((link) => [link.attributeId.toHexString(), link.required]),
    );
  }
}
