import {
  ConflictError,
  type ReadDocumentOf,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { resources } from "../resources/resources.model";
import { claimRoles, rolesOfUser } from "./role-claims";
import {
  cleanDescription,
  cleanName,
  conflict,
  MAX_ID,
  refuse,
} from "./roles.input";
import type { roleAssignments, roles } from "./roles.model";

export type RoleDoc = ReadDocumentOf<typeof roles>;
export type AssignmentDoc = ReadDocumentOf<typeof roleAssignments>;

export interface RolesOptions {
  roles: TypedCollection<typeof roles>;
  assignments: TypedCollection<typeof roleAssignments>;
  /** Read only: to scope a role to a resource and to find the resource of a token's audience. */
  resources: TypedCollection<typeof resources>;
}

/**
 * A tenant's end-user roles and their assignments (slice A2c). Every method
 * takes the tenant's id and reads and writes through its scope, so a role or
 * assignment of another tenant is "not found". Deletes and unassigns are
 * idempotent; assigning twice is one assignment.
 */
export class RolesService {
  constructor(private readonly options: RolesOptions) {}

  private rolesOf(tenantId: ObjectId) {
    return scopeToTenant(this.options.roles, tenantId);
  }

  private assignmentsOf(tenantId: ObjectId) {
    return scopeToTenant(this.options.assignments, tenantId);
  }

  private resourcesOf(tenantId: ObjectId) {
    return scopeToTenant(this.options.resources, tenantId);
  }

  async list(
    tenantId: ObjectId,
    filter: { resourceId?: string | undefined } = {},
  ): Promise<RoleDoc[]> {
    let found: RoleDoc[];
    if (filter.resourceId === undefined) {
      found = await this.rolesOf(tenantId).findMany();
    } else {
      if (!ObjectId.isValid(filter.resourceId)) return [];
      found = await this.rolesOf(tenantId).findMany({
        filter: { resourceId: new ObjectId(filter.resourceId) },
      });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  async find(tenantId: ObjectId, roleId: string): Promise<RoleDoc | undefined> {
    if (!ObjectId.isValid(roleId)) return undefined;
    return this.rolesOf(tenantId).findById(new ObjectId(roleId));
  }

  async memberCount(tenantId: ObjectId, role: RoleDoc): Promise<number> {
    return this.assignmentsOf(tenantId).count({ roleId: role._id });
  }

  /** The holders of each role in one query, by role id (hex); a role nobody holds counts 0. */
  async memberCounts(
    tenantId: ObjectId,
    found: readonly RoleDoc[],
  ): Promise<Map<string, number>> {
    const counts = new Map(found.map((role) => [role._id.toHexString(), 0]));
    if (found.length === 0) return counts;
    // Grouped on the server; the tenant is in the match, as a scope would put it.
    const grouped = await this.options.assignments.raw
      .aggregate<{ _id: ObjectId; n: number }>([
        { $match: { tenantId, roleId: { $in: found.map((r) => r._id) } } },
        { $group: { _id: "$roleId", n: { $sum: 1 } } },
      ])
      .toArray();
    for (const { _id, n } of grouped) counts.set(_id.toHexString(), n);
    return counts;
  }

  async create(
    tenantId: ObjectId,
    input: {
      name: string;
      description?: string | undefined;
      resourceId?: string | null | undefined;
    },
  ): Promise<RoleDoc> {
    const name = cleanName(input.name);
    const description = cleanDescription(input.description);
    let resourceId: ObjectId | null = null;
    if (input.resourceId !== undefined && input.resourceId !== null) {
      const resource = ObjectId.isValid(input.resourceId)
        ? await this.resourcesOf(tenantId).findById(
            new ObjectId(input.resourceId),
          )
        : undefined;
      if (resource === undefined) refuse("NOT_FOUND", "No such resource");
      resourceId = resource?._id ?? null;
    }
    try {
      const created = await this.rolesOf(tenantId).create({
        name,
        description,
        resourceId,
      });
      // The resource may have been deleted since it was read, after its roles
      // were cleaned up: take the role back rather than leave it dangling.
      if (
        resourceId !== null &&
        (await this.resourcesOf(tenantId).findById(resourceId)) === undefined
      ) {
        await this.rolesOf(tenantId).hardDeleteMany({ _id: created._id });
        refuse("NOT_FOUND", "No such resource");
      }
      return created;
    } catch (error) {
      if (error instanceof ConflictError) throw conflict(name);
      throw error;
    }
  }

  /** Name and description only: the resource of a role never changes (tokens carry its name per audience). */
  async update(
    tenantId: ObjectId,
    roleId: string,
    input: { name?: string | undefined; description?: string | undefined },
  ): Promise<RoleDoc> {
    const existing = await this.find(tenantId, roleId);
    if (existing === undefined) refuse("NOT_FOUND", "No such role");
    const found = existing as RoleDoc;
    const name = input.name === undefined ? found.name : cleanName(input.name);
    const description =
      input.description === undefined
        ? found.description
        : cleanDescription(input.description);
    if (name === found.name && description === found.description) return found;
    try {
      return await this.rolesOf(tenantId).update(found._id, {
        name,
        description,
      });
    } catch (error) {
      if (error instanceof ConflictError) throw conflict(name);
      throw error;
    }
  }

  /**
   * Deletes the role and its assignments; `false` when it was not there. The
   * role goes first, then the sweep, and the sweep runs on a repeat too: an
   * `assign` that re-checks the role after its write then sees it gone, in
   * every ordering, and a run that stopped between the two is finished.
   */
  async delete(tenantId: ObjectId, roleId: string): Promise<boolean> {
    if (!ObjectId.isValid(roleId)) return false;
    const id = new ObjectId(roleId);
    const removed =
      (await this.rolesOf(tenantId).hardDeleteMany({ _id: id })) > 0;
    await this.assignmentsOf(tenantId).hardDeleteMany({ roleId: id });
    return removed;
  }

  /** The roles scoped to a resource that is being deleted, removed with their assignments; the roles removed. */
  async deleteForResource(
    tenantId: ObjectId,
    resourceId: ObjectId,
  ): Promise<RoleDoc[]> {
    const own = await this.rolesOf(tenantId).findMany({
      filter: { resourceId },
    });
    for (const role of own) await this.delete(tenantId, role._id.toHexString());
    return own;
  }

  /**
   * Gives the user the role. Idempotent. The caller checked the user exists in
   * the tenant's pool. `NOT_FOUND` for an unknown role.
   */
  async assign(
    tenantId: ObjectId,
    roleId: string,
    userId: string,
  ): Promise<void> {
    const role = await this.find(tenantId, roleId);
    if (role === undefined) return refuse("NOT_FOUND", "No such role");
    if (userId.length === 0 || userId.length > MAX_ID) {
      refuse("BAD_USER_INPUT", "userId is not an id");
    }
    try {
      await this.assignmentsOf(tenantId).create({ roleId: role._id, userId });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
    // The role may have been deleted between the check and the write: leave
    // no assignment to a role that is gone.
    if ((await this.find(tenantId, roleId)) === undefined) {
      await this.assignmentsOf(tenantId).hardDeleteMany({ roleId: role._id });
      refuse("NOT_FOUND", "No such role");
    }
  }

  /** `true` when the user held the role. */
  async unassign(
    tenantId: ObjectId,
    roleId: string,
    userId: string,
  ): Promise<boolean> {
    if (!ObjectId.isValid(roleId)) return false;
    return (
      (await this.assignmentsOf(tenantId).hardDeleteMany({
        roleId: new ObjectId(roleId),
        userId,
      })) > 0
    );
  }

  /** Removes every assignment of a deleted user. */
  async removeUser(tenantId: ObjectId, userId: string): Promise<number> {
    return this.assignmentsOf(tenantId).hardDeleteMany({ userId });
  }

  /** One page of a role's assignments, oldest first. */
  async members(
    tenantId: ObjectId,
    roleId: string,
    page: { after: string | null; limit: number },
  ): Promise<{ items: AssignmentDoc[]; nextCursor: string | null }> {
    if (!ObjectId.isValid(roleId)) return { items: [], nextCursor: null };
    return this.assignmentsOf(tenantId).paginateByCursor({
      filter: { roleId: new ObjectId(roleId) },
      after: page.after,
      limit: page.limit,
    });
  }

  /** The roles a user holds, by name. */
  rolesOfUser(tenantId: ObjectId, userId: string): Promise<RoleDoc[]> {
    return rolesOfUser(this.options, tenantId, userId);
  }

  /**
   * The `roles` claim of a user: the names of the tenant-wide roles they hold,
   * plus, for a token whose audience is the URI of a resource of the tenant,
   * those scoped to that resource. Sorted, one entry per name.
   */
  claimRoles(
    tenantId: ObjectId,
    userId: string,
    audience: string | null,
  ): Promise<string[]> {
    return claimRoles(this.options, tenantId, userId, audience);
  }
}
