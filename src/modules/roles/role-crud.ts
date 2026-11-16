import { ConflictError, type Scoped } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { resources } from "../resources/resources.model";
import {
  cleanDescription,
  cleanName,
  conflict,
  managedRefusal,
  refuse,
} from "./roles.input";
import type { roleAssignments, roles } from "./roles.model";
import type { RoleDoc } from "./roles.service";

type OwnRoles = Scoped<typeof roles>;
type OwnAssignments = Scoped<typeof roleAssignments>;
type OwnResources = Scoped<typeof resources>;

/** Creates a role, optionally scoped to a resource of the tenant (`NOT_FOUND` when it is unknown). */
export async function createRole(
  ownRoles: OwnRoles,
  ownResources: OwnResources,
  input: {
    name: string;
    description?: string | undefined;
    resourceId?: string | null | undefined;
    /** Set by Clavix's own code for a role it provides; never from the console's input. */
    managed?: boolean | undefined;
  },
): Promise<RoleDoc> {
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  let resourceId: ObjectId | null = null;
  if (input.resourceId !== undefined && input.resourceId !== null) {
    const resource = ObjectId.isValid(input.resourceId)
      ? await ownResources.findById(new ObjectId(input.resourceId))
      : undefined;
    if (resource === undefined) refuse("NOT_FOUND", "No such resource");
    resourceId = resource?._id ?? null;
  }
  try {
    const created = await ownRoles.create({
      name,
      description,
      resourceId,
      managed: input.managed ?? false,
    });
    // The resource may have been deleted since it was read, after its roles
    // were cleaned up: take the role back rather than leave it dangling.
    if (
      resourceId !== null &&
      (await ownResources.findById(resourceId)) === undefined
    ) {
      await ownRoles.hardDeleteMany({ _id: created._id });
      refuse("NOT_FOUND", "No such resource");
    }
    return created;
  } catch (error) {
    if (error instanceof ConflictError) {
      // A repeat of a call whose audit record failed: the stored role is
      // returned when it is the one asked for.
      const [existing] = await ownRoles.findMany({
        filter: { name, resourceId },
      });
      if (existing !== undefined && existing.description === description) {
        return existing;
      }
      throw conflict(name);
    }
    throw error;
  }
}

/** Name and description only: the resource of a role never changes (tokens carry its name per audience). */
export async function updateRole(
  ownRoles: OwnRoles,
  found: RoleDoc,
  input: { name?: string | undefined; description?: string | undefined },
): Promise<RoleDoc> {
  if (found.managed) throw managedRefusal(found.name);
  const name = input.name === undefined ? found.name : cleanName(input.name);
  const description =
    input.description === undefined
      ? found.description
      : cleanDescription(input.description);
  if (name === found.name && description === found.description) return found;
  try {
    return await ownRoles.update(found._id, {
      name,
      description,
    });
  } catch (error) {
    if (error instanceof ConflictError) throw conflict(name);
    throw error;
  }
}

/** The removal itself, for `delete` and for the cascade of a deleted resource (which takes managed roles too). */
export async function removeRole(
  ownRoles: OwnRoles,
  ownAssignments: OwnAssignments,
  roleId: string,
): Promise<boolean> {
  if (!ObjectId.isValid(roleId)) return false;
  const id = new ObjectId(roleId);
  const removed = (await ownRoles.hardDeleteMany({ _id: id })) > 0;
  await ownAssignments.hardDeleteMany({ roleId: id });
  return removed;
}
