import type { RelationStore } from "@softistx/janus/permissions";
import { PLATFORM, type TenantRole, tenantOf, userOf } from "./access-objects";
import { ROLES, type Role } from "./model";

/** The reads of the console's permissions over a janus relation store. */
export function accessReads(store: RelationStore) {
  return {
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
  };
}
