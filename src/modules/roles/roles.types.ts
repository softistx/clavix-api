import type { ReadDocumentOf, TypedCollection } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { resources } from "@/modules/resources";
import type { roleAssignments, roles } from "./roles.model";

export type RoleDoc = ReadDocumentOf<typeof roles>;
export type AssignmentDoc = ReadDocumentOf<typeof roleAssignments>;

/** What a deleted role asks of the attributes module: its role-attribute links go with it. */
export interface RoleLinks {
  /** Removes every attribute link of the role. Idempotent. */
  removeForRole(tenantId: ObjectId, roleId: ObjectId): Promise<void>;
}

/** What a role needs to know of a scope (a document of the resources module). */
export interface ScopeRef {
  _id: ObjectId;
  /** The OAuth scope token. */
  name: string;
  /** The resource it belongs to; `null` for a standard OpenID Connect scope. */
  resourceId: ObjectId | null;
}

/** The roles module's read-only view of the tenant's scopes. Required: bound in `src/config/roles.ts`. */
export interface RoleScopes {
  /** The scopes of the tenant among `ids`; an id that names none is left out. */
  find(tenantId: ObjectId, ids: readonly ObjectId[]): Promise<ScopeRef[]>;
}

/** What the console's `TenantRole` resolvers read: the shape and what its fields need. */
export interface TenantRoleParent {
  id: string;
  name: string;
  description: string | null;
  resourceId: string | null;
  managed: boolean;
  memberCount: number;
  createdAt: Date;
  tenantId: string;
  /** Scope ids (hex), for `TenantRole.permissions`. */
  permissionIds: string[];
}

export interface RolesOptions {
  roles: TypedCollection<typeof roles>;
  assignments: TypedCollection<typeof roleAssignments>;
  /** Read only: to scope a role to a resource and to find the resource of a token's audience. */
  resources: TypedCollection<typeof resources>;
  /** The attribute links of a role, removed with it. Required: bound in `src/config/roles.ts`. */
  roleLinks: RoleLinks;
  /** Scopes a role may hold, checked on `setPermissions`. Required: bound in `src/config/roles.ts`. */
  scopes: RoleScopes;
}

export interface CreateRoleInput {
  name: string;
  description?: string | undefined;
  resourceId?: string | null | undefined;
  /** Set by Clavix's own code for a role it provides; never from the console's input. */
  managed?: boolean | undefined;
}

/** Name and description only: the resource of a role never changes. */
export interface UpdateRoleInput {
  name?: string | undefined;
  description?: string | undefined;
}

export interface MembersPage {
  items: AssignmentDoc[];
  nextCursor: string | null;
}
