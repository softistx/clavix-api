import { permissions, type RelationStore } from "@softistx/janus/permissions";
import { model, type Permission, ROLES, type Role } from "./model";

/** The one platform object: Clavix itself. */
export const PLATFORM = { type: "platform", id: "clavix" } as const;

const userOf = (id: string) => ({ type: "user", id }) as const;
const tenantOf = (id: string) => ({ type: "tenant", id }) as const;

/** A role a user holds directly on a tenant (not through the platform). */
export interface TenantRole {
  tenantId: string;
  role: Role;
}

/**
 * The console's permissions over a janus relation store: the checks the guard
 * asks, and the writes that grant a role. Subjects are users of the `clavix`
 * tenant; tenant ids are the hex ids of `tenants`.
 */
export function createAccess(store: RelationStore) {
  const access = permissions({ model, store });

  /** The tenant's `platform` link, so a platform role carries over to it. Idempotent. */
  const linkTenant = (tenantId: string) =>
    access.grant(tenantOf(tenantId), "platform", PLATFORM);

  return {
    /** Whether the user has `permission` on the tenant (directly or through the platform). */
    can: (userId: string, permission: Permission, tenantId: string) =>
      access.can(userOf(userId), permission, tenantOf(tenantId)),

    /** Whether the user has `permission` on the platform itself. */
    canPlatform: (userId: string, permission: Permission) =>
      access.can(userOf(userId), permission, PLATFORM),

    /** The user's platform role (the strongest), or `null`. */
    async platformRole(userId: string): Promise<Role | null> {
      for (const role of ROLES) {
        if (
          await store.has({
            object: PLATFORM,
            relation: role,
            subject: userOf(userId),
          })
        ) {
          return role;
        }
      }
      return null;
    },

    /** The roles the user holds directly on tenants, strongest first per tenant. */
    async memberships(userId: string): Promise<TenantRole[]> {
      const found = new Map<string, Role>();
      // Strongest last, so it overwrites a weaker role on the same tenant.
      for (const role of [...ROLES].reverse()) {
        let after: string | null = null;
        do {
          const page = await store.findObjects({
            type: "tenant",
            relation: role,
            subject: userOf(userId),
            after,
            limit: 100,
          });
          for (const tenantId of page.items) found.set(tenantId, role);
          after = page.nextCursor;
        } while (after !== null);
      }
      return [...found].map(([tenantId, role]) => ({ tenantId, role }));
    },

    /** The users who hold `role` directly on the tenant. */
    async holders(tenantId: string, role: Role): Promise<string[]> {
      const found = await store.findEntities(tenantOf(tenantId), role);
      return found.filter(({ type }) => type === "user").map(({ id }) => id);
    },

    linkTenant,

    /** The ids of the users holding `owner` directly on the tenant. */
    async owners(tenantId: string): Promise<string[]> {
      const found = await store.findEntities(tenantOf(tenantId), "owner");
      return found.filter((e) => e.type === "user").map((e) => e.id);
    },

    /** The users who hold `role` directly on the platform. */
    async platformHolders(role: Role): Promise<string[]> {
      const found = await store.findEntities(PLATFORM, role);
      return found.filter(({ type }) => type === "user").map(({ id }) => id);
    },

    /** The ids of the users holding the platform `owner` role. */
    async platformOwners(): Promise<string[]> {
      const found = await store.findEntities(PLATFORM, "owner");
      return found.filter((e) => e.type === "user").map((e) => e.id);
    },

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
