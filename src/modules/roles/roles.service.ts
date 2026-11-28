import { ConflictError, scopeToTenant } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { conflict, managedRefusal, refuse } from "./roles.errors";
import {
  checkPermissions,
  checkUserId,
  cleanDescription,
  cleanName,
  permissionObjectIds,
} from "./roles.rules";
import type {
  AssignmentDoc,
  CreateRoleInput,
  MembersPage,
  RoleDoc,
  RolesOptions,
  UpdateRoleInput,
} from "./roles.types";
import {
  claimNames,
  countsByRole,
  heldRoles,
  permissionIdsOf,
  sameIds,
  scopeNamesOf,
  sortedByName,
} from "./roles.utils";

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
    if (filter.resourceId === undefined) {
      return sortedByName(await this.rolesOf(tenantId).findMany());
    }
    if (!ObjectId.isValid(filter.resourceId)) return [];
    const found = await this.rolesOf(tenantId).findMany({
      filter: { resourceId: new ObjectId(filter.resourceId) },
    });
    return sortedByName(found);
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
    if (found.length === 0) return countsByRole(found, []);
    // Grouped on the server; the tenant is in the match, as a scope would put it.
    const grouped = await this.options.assignments.raw
      .aggregate<{ _id: ObjectId; n: number }>([
        { $match: { tenantId, roleId: { $in: found.map((r) => r._id) } } },
        { $group: { _id: "$roleId", n: { $sum: 1 } } },
      ])
      .toArray();
    return countsByRole(found, grouped);
  }

  /** Creates a role, optionally scoped to a resource of the tenant (`NOT_FOUND` when it is unknown). */
  async create(tenantId: ObjectId, input: CreateRoleInput): Promise<RoleDoc> {
    const name = cleanName(input.name);
    const description = cleanDescription(input.description);
    const resourceId = await this.resourceIdOf(tenantId, input.resourceId);
    const own = this.rolesOf(tenantId);
    try {
      const created = await own.create({
        name,
        description,
        resourceId,
        managed: input.managed ?? false,
      });
      await this.dropIfResourceGone(tenantId, created, resourceId);
      return created;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      // A repeat of a call whose audit record failed: the stored role is
      // returned when it is the one asked for.
      const [existing] = await own.findMany({ filter: { name, resourceId } });
      if (existing?.description === description) return existing;
      throw conflict(name);
    }
  }

  /** The resource a new role is scoped to, `null` for the whole tenant. */
  private async resourceIdOf(
    tenantId: ObjectId,
    resourceId: string | null | undefined,
  ): Promise<ObjectId | null> {
    if (resourceId === undefined || resourceId === null) return null;
    const resource = ObjectId.isValid(resourceId)
      ? await this.resourcesOf(tenantId).findById(new ObjectId(resourceId))
      : undefined;
    if (resource === undefined) return refuse("NOT_FOUND", "No such resource");
    return resource._id;
  }

  /**
   * The resource may have been deleted since it was read, after its roles
   * were cleaned up: take the role back rather than leave it dangling.
   */
  private async dropIfResourceGone(
    tenantId: ObjectId,
    created: RoleDoc,
    resourceId: ObjectId | null,
  ): Promise<void> {
    if (resourceId === null) return;
    if ((await this.resourcesOf(tenantId).findById(resourceId)) !== undefined) {
      return;
    }
    await this.rolesOf(tenantId).hardDeleteMany({ _id: created._id });
    refuse("NOT_FOUND", "No such resource");
  }

  /** Name and description only: the resource of a role never changes (tokens carry its name per audience). */
  async update(
    tenantId: ObjectId,
    roleId: string,
    input: UpdateRoleInput,
  ): Promise<RoleDoc> {
    const found = await this.find(tenantId, roleId);
    if (found === undefined) return refuse("NOT_FOUND", "No such role");
    if (found.managed) throw managedRefusal(found.name);
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
   * Deletes the role, its assignments and its attribute links; `false` when it was not there. A
   * managed role is refused (`ROLE_MANAGED`). The role goes first, then the
   * sweep, and the sweep runs on a repeat too: an `assign` that re-checks the
   * role after its write then sees it gone, in every ordering, and a run that
   * stopped between the two is finished.
   */
  async delete(tenantId: ObjectId, roleId: string): Promise<boolean> {
    const existing = await this.find(tenantId, roleId);
    // A managed role is refused; an unknown one still sweeps (a repeat).
    if (existing?.managed) throw managedRefusal(existing.name);
    return this.remove(tenantId, roleId);
  }

  /** The removal itself, for `delete` and for the cascade of a deleted resource (which takes managed roles too). */
  private async remove(tenantId: ObjectId, roleId: string): Promise<boolean> {
    if (!ObjectId.isValid(roleId)) return false;
    const id = new ObjectId(roleId);
    const removed =
      (await this.rolesOf(tenantId).hardDeleteMany({ _id: id })) > 0;
    await this.assignmentsOf(tenantId).hardDeleteMany({ roleId: id });
    // The role's attribute links go too; the users' values stay, hidden.
    await this.options.roleLinks.removeForRole(tenantId, id);
    return removed;
  }

  /**
   * Replaces the scopes the role holds (`permissionIds`, ids of the tenant's
   * scopes). Idempotent: the same set writes nothing. `NOT_FOUND` for an
   * unknown role, `ROLE_MANAGED` for a managed one, `BAD_USER_INPUT` at
   * `permissionIds.<i>` for a scope the role may not hold (see `checkPermissions`).
   */
  async setPermissions(
    tenantId: ObjectId,
    roleId: string,
    permissionIds: readonly string[],
  ): Promise<RoleDoc> {
    const found = await this.find(tenantId, roleId);
    if (found === undefined) return refuse("NOT_FOUND", "No such role");
    if (found.managed) throw managedRefusal(found.name);
    const wanted = permissionObjectIds(permissionIds);
    checkPermissions(
      permissionIds,
      found.resourceId,
      await this.options.scopes.find(tenantId, wanted),
    );
    if (sameIds(found.permissionIds, wanted)) return found;
    return this.rolesOf(tenantId).update(found._id, { permissionIds: wanted });
  }

  /**
   * The cascade of a deleted resource: its scope ids leave the tenant-wide
   * roles that hold them (a role scoped to the resource is deleted with it).
   * Returns the roles changed.
   */
  async pullScopes(
    tenantId: ObjectId,
    scopeIds: readonly ObjectId[],
  ): Promise<RoleDoc[]> {
    if (scopeIds.length === 0) return [];
    const held = { permissionIds: { $in: [...scopeIds] } };
    const holders = await this.rolesOf(tenantId).findMany({ filter: held });
    if (holders.length === 0) return [];
    // One atomic $pull, so a concurrent setRolePermissions is never rewritten.
    await this.rolesOf(tenantId).updateMany(held, {
      $pull: { permissionIds: { $in: [...scopeIds] } },
    });
    return holders;
  }

  /** At most `limit` ids (hex) of the tenant's roles that grant the scope. */
  async rolesGranting(
    tenantId: ObjectId,
    scopeId: ObjectId,
    limit: number,
  ): Promise<string[]> {
    const holders = await this.rolesOf(tenantId).findMany({
      filter: { permissionIds: scopeId },
      projection: { _id: 1 },
      limit,
    });
    return holders.map((role) => role._id.toHexString());
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
    checkUserId(userId);
    const own = this.assignmentsOf(tenantId);
    try {
      await own.create({ roleId: role._id, userId });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
    // The role may have been deleted between the check and the write: leave
    // no assignment to a role that is gone.
    if ((await this.find(tenantId, roleId)) === undefined) {
      await own.hardDeleteMany({ roleId: role._id });
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
    const removed = await this.assignmentsOf(tenantId).hardDeleteMany({
      roleId: new ObjectId(roleId),
      userId,
    });
    return removed > 0;
  }

  /** Removes every assignment of a deleted user. */
  removeUser(tenantId: ObjectId, userId: string): Promise<number> {
    return this.assignmentsOf(tenantId).hardDeleteMany({ userId });
  }

  /** One page of a role's assignments, oldest first. */
  async members(
    tenantId: ObjectId,
    roleId: string,
    page: { after: string | null; limit: number },
  ): Promise<MembersPage> {
    if (!ObjectId.isValid(roleId)) return { items: [], nextCursor: null };
    return this.assignmentsOf(tenantId).paginateByCursor({
      filter: { roleId: new ObjectId(roleId) },
      after: page.after,
      limit: page.limit,
    });
  }

  /** How many users hold the role (assignments), whatever the page. 0 for an unknown role. */
  async membersCount(tenantId: ObjectId, roleId: string): Promise<number> {
    if (!ObjectId.isValid(roleId)) return 0;
    return this.assignmentsOf(tenantId).count({ roleId: new ObjectId(roleId) });
  }

  /**
   * What the roles module holds about a user, for a data export: each role they
   * hold, by name, with the date it was assigned. Nothing about the roles themselves.
   */
  async personalDataOf(
    tenantId: ObjectId,
    userId: string,
  ): Promise<{ role: string; assignedAt: Date }[]> {
    const held = await this.assignmentsOf(tenantId).findMany({
      filter: { userId },
    });
    const roles = await this.rolesOf(tenantId).findMany();
    const names = new Map(roles.map((r) => [r._id.toHexString(), r.name]));
    return held
      .map((a) => ({
        role: names.get(a.roleId.toHexString()) ?? a.roleId.toHexString(),
        assignedAt: a.createdAt,
      }))
      .sort((a, b) => a.role.localeCompare(b.role));
  }

  /** The roles a user holds, by name. */
  async rolesOfUser(tenantId: ObjectId, userId: string): Promise<RoleDoc[]> {
    const held: AssignmentDoc[] = await this.assignmentsOf(tenantId).findMany({
      filter: { userId },
    });
    if (held.length === 0) return [];
    const ids = new Set(held.map((a) => a.roleId.toHexString()));
    return heldRoles(await this.rolesOf(tenantId).findMany(), ids);
  }

  /**
   * The `roles` claim of a user: the names of the tenant-wide roles they hold,
   * plus, for a token whose audience is the URI of a resource of the tenant,
   * those scoped to that resource. Sorted, one entry per name.
   */
  async claimRoles(
    tenantId: ObjectId,
    userId: string,
    audience: string | null,
  ): Promise<string[]> {
    const held = await this.rolesOfUser(tenantId, userId);
    if (held.length === 0) return [];
    let resourceId: string | null = null;
    if (audience !== null) {
      const resource = await this.resourcesOf(tenantId).findFirst({
        uri: audience,
      });
      resourceId = resource?._id.toHexString() ?? null;
    }
    return claimNames(held, resourceId);
  }

  /**
   * The `roles` and `permissions` claims of a user for a resource that enforces
   * RBAC, with the resource and the held roles read once (slice 5.2a).
   * `roles` is as `claimRoles`. `permissions` holds the sorted, de-duplicated
   * names of the scopes of the resource whose URI is `audience`, granted by the
   * roles held there (tenant-wide and scoped to it): `[]` when none, `null`
   * (no claim) when there is no audience, no such resource, or it does not
   * enforce RBAC.
   */
  async claimAccess(
    tenantId: ObjectId,
    userId: string,
    audience: string | null,
  ): Promise<{ roles: string[]; permissions: string[] | null }> {
    const held = await this.rolesOfUser(tenantId, userId);
    const resource =
      audience === null
        ? undefined
        : await this.resourcesOf(tenantId).findFirst({ uri: audience });
    const roles = claimNames(held, resource?._id.toHexString() ?? null);
    if (resource === undefined || resource.enforceRbac !== true) {
      return { roles, permissions: null };
    }
    const ids = permissionIdsOf(held, resource._id);
    if (ids.length === 0) return { roles, permissions: [] };
    const scopes = await this.options.scopes.find(tenantId, ids);
    return { roles, permissions: scopeNamesOf(scopes, resource._id) };
  }
}
