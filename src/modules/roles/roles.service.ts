import {
  type ReadDocumentOf,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { resources } from "@/modules/resources";
import { assign, members, removeUser, unassign } from "./role-assignments";
import { claimRoles, rolesOfUser } from "./role-claims";
import { memberCounts } from "./role-counts";
import { createRole, removeRole, updateRole } from "./role-crud";
import { managedRefusal, refuse } from "./roles.input";
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
    return memberCounts(this.options.assignments, tenantId, found);
  }

  create(
    tenantId: ObjectId,
    input: {
      name: string;
      description?: string | undefined;
      resourceId?: string | null | undefined;
      /** Set by Clavix's own code for a role it provides; never from the console's input. */
      managed?: boolean | undefined;
    },
  ): Promise<RoleDoc> {
    return createRole(
      this.rolesOf(tenantId),
      this.resourcesOf(tenantId),
      input,
    );
  }

  /** Name and description only: the resource of a role never changes (tokens carry its name per audience). */
  async update(
    tenantId: ObjectId,
    roleId: string,
    input: { name?: string | undefined; description?: string | undefined },
  ): Promise<RoleDoc> {
    const existing = await this.find(tenantId, roleId);
    if (existing === undefined) refuse("NOT_FOUND", "No such role");
    return updateRole(this.rolesOf(tenantId), existing, input);
  }

  /**
   * Deletes the role and its assignments; `false` when it was not there. A
   * managed role is refused (`ROLE_MANAGED`). The
   * role goes first, then the sweep, and the sweep runs on a repeat too: an
   * `assign` that re-checks the role after its write then sees it gone, in
   * every ordering, and a run that stopped between the two is finished.
   */
  async delete(tenantId: ObjectId, roleId: string): Promise<boolean> {
    const existing = await this.find(tenantId, roleId);
    // A managed role is refused; an unknown one still sweeps (a repeat).
    if (existing?.managed) throw managedRefusal(existing.name);
    return this.remove(tenantId, roleId);
  }

  private remove(tenantId: ObjectId, roleId: string): Promise<boolean> {
    return removeRole(
      this.rolesOf(tenantId),
      this.assignmentsOf(tenantId),
      roleId,
    );
  }

  /** The roles scoped to a resource that is being deleted, removed with their assignments; the roles removed. */
  async deleteForResource(
    tenantId: ObjectId,
    resourceId: ObjectId,
  ): Promise<RoleDoc[]> {
    const own = await this.rolesOf(tenantId).findMany({
      filter: { resourceId },
    });
    for (const role of own) await this.remove(tenantId, role._id.toHexString());
    return own;
  }

  /** See `assign` of `role-assignments.ts`. */
  assign(tenantId: ObjectId, roleId: string, userId: string): Promise<void> {
    return assign(
      this.assignmentsOf(tenantId),
      (id) => this.find(tenantId, id),
      roleId,
      userId,
    );
  }

  /** `true` when the user held the role. */
  unassign(
    tenantId: ObjectId,
    roleId: string,
    userId: string,
  ): Promise<boolean> {
    return unassign(this.assignmentsOf(tenantId), roleId, userId);
  }

  /** Removes every assignment of a deleted user. */
  removeUser(tenantId: ObjectId, userId: string): Promise<number> {
    return removeUser(this.assignmentsOf(tenantId), userId);
  }

  /** One page of a role's assignments, oldest first. */
  members(
    tenantId: ObjectId,
    roleId: string,
    page: { after: string | null; limit: number },
  ): Promise<{ items: AssignmentDoc[]; nextCursor: string | null }> {
    return members(this.assignmentsOf(tenantId), roleId, page);
  }

  /** How many users hold the role (assignments), whatever the page. 0 for an unknown role. */
  async membersCount(tenantId: ObjectId, roleId: string): Promise<number> {
    if (!ObjectId.isValid(roleId)) return 0;
    return this.assignmentsOf(tenantId).count({ roleId: new ObjectId(roleId) });
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
