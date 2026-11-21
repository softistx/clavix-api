import { permissions, type RelationStore } from "@softistx/janus/permissions";
import { PLATFORM, tenantOf, userOf } from "./access-objects";
import { accessReads } from "./access-reads";
import { model, type Permission, type Role } from "./model";

export { PLATFORM, type TenantRole } from "./access-objects";

/**
 * The console's permissions over a janus relation store: the checks the guard
 * asks (`can`, `canPlatform`), the reads (`access-reads.ts`) and the writes
 * that grant a role. Subjects are users of the `clavix` tenant; tenant ids are
 * the hex ids of `tenants`.
 */
export function createAccess(store: RelationStore) {
  const access = permissions({ model, store });

  return {
    /** Whether the user has `permission` on the tenant (directly or through the platform). */
    can: (userId: string, permission: Permission, tenantId: string) =>
      access.can(userOf(userId), permission, tenantOf(tenantId)),

    /** Whether the user has `permission` on the platform itself. */
    canPlatform: (userId: string, permission: Permission) =>
      access.can(userOf(userId), permission, PLATFORM),

    ...accessReads(store),

    /** The tenant's `platform` link, so a platform role carries over to it. Idempotent. */
    linkTenant: (tenantId: string) =>
      access.grant(tenantOf(tenantId), "platform", PLATFORM),

    grantPlatform: (userId: string, role: Role) =>
      access.grant(PLATFORM, role, userOf(userId)),

    grantTenant: (tenantId: string, userId: string, role: Role) =>
      access.grant(tenantOf(tenantId), role, userOf(userId)),

    /** Removes every tuple of the tenant: its roles and its platform link (the purge). Idempotent. */
    removeTenant: (tenantId: string) => store.deleteEntity(tenantOf(tenantId)),

    /** Removes every tuple naming the user: their platform and tenant roles. Idempotent. */
    removeUser: (userId: string) => store.deleteEntity(userOf(userId)),

    revokeTenant: (tenantId: string, userId: string, role: Role) =>
      access.revoke(tenantOf(tenantId), role, userOf(userId)),
  };
}

export type Access = ReturnType<typeof createAccess>;
