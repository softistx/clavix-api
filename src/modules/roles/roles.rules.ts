import { ObjectId } from "mongodb";
import { refuse } from "./roles.errors";
import type { ScopeRef } from "./roles.types";

const NAME = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_DESCRIPTION = 300;
export const MAX_ID = 200;

/** The trimmed role name; `BAD_USER_INPUT` when it is not 1 to 64 safe characters. */
export function cleanName(name: string): string {
  const clean = name.trim();
  if (!NAME.test(clean)) {
    refuse(
      "BAD_USER_INPUT",
      "a role name is 1 to 64 characters of letters, digits, '.', '_', ':' and '-'",
    );
  }
  return clean;
}

/** The trimmed description (empty when none); `BAD_USER_INPUT` past 300 characters. */
export function cleanDescription(text: string | undefined): string {
  const clean = (text ?? "").trim();
  if (clean.length > MAX_DESCRIPTION) {
    refuse(
      "BAD_USER_INPUT",
      `a description has at most ${MAX_DESCRIPTION} characters`,
    );
  }
  return clean;
}

/** A janus user id is a non-empty string of at most 200 characters. */
export function checkUserId(userId: string): void {
  if (userId.length === 0 || userId.length > MAX_ID) {
    refuse("BAD_USER_INPUT", "userId is not an id");
  }
}

export const MAX_PERMISSIONS = 500;

/** The ids of `permissionIds` (at most MAX_PERMISSIONS, checked first) that are well formed, one per scope (first occurrence), as ObjectIds. */
export function permissionObjectIds(ids: readonly string[]): ObjectId[] {
  if (ids.length > MAX_PERMISSIONS) {
    refuse(
      "BAD_USER_INPUT",
      `a role holds at most ${MAX_PERMISSIONS} permissions`,
      "permissionIds",
    );
  }
  const seen = new Set<string>();
  const out: ObjectId[] = [];
  for (const [index, given] of ids.entries()) {
    if (!ObjectId.isValid(given)) {
      refuse("BAD_USER_INPUT", "not a scope id", `permissionIds.${index}`);
    }
    const scopeId = new ObjectId(given);
    if (seen.has(scopeId.toHexString())) continue;
    seen.add(scopeId.toHexString());
    out.push(scopeId);
  }
  return out;
}

/**
 * Checks the scopes a role is asked to hold, each breach `BAD_USER_INPUT` at
 * `permissionIds.<i>`: a scope that does not exist, a standard OpenID Connect
 * scope (never a permission), or, for a role scoped to a resource, a scope of
 * another resource. A tenant-wide role may hold the scopes of any resource.
 */
export function checkPermissions(
  ids: readonly string[],
  roleResourceId: ObjectId | null,
  found: readonly ScopeRef[],
): void {
  const byId = new Map(found.map((scope) => [scope._id.toHexString(), scope]));
  for (const [index, given] of ids.entries()) {
    const field = `permissionIds.${index}`;
    const scope = byId.get(new ObjectId(given).toHexString());
    if (scope === undefined) refuse("BAD_USER_INPUT", "No such scope", field);
    if (scope.resourceId === null) {
      refuse(
        "BAD_USER_INPUT",
        "A standard OpenID Connect scope is never a permission",
        field,
      );
    }
    if (roleResourceId !== null && !scope.resourceId.equals(roleResourceId)) {
      refuse(
        "BAD_USER_INPUT",
        "A role scoped to a resource holds only that resource's scopes",
        field,
      );
    }
  }
}
