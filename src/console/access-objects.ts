import type { Role } from "./model";

/** The one platform object: Clavix itself. */
export const PLATFORM = { type: "platform", id: "clavix" } as const;

export const userOf = (id: string) => ({ type: "user", id }) as const;
export const tenantOf = (id: string) => ({ type: "tenant", id }) as const;

/** A role a user holds directly on a tenant (not through the platform). */
export interface TenantRole {
  tenantId: string;
  role: Role;
}
