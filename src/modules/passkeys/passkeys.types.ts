import type { TenantJanus } from "@/modules/users/tenant-janus";

/** What `PasskeysService` is built over: the tenants' janus instances and the activity counter. */
export interface PasskeysPorts {
  /** The janus instance of the request's host; `null` for a host that names no active tenant. */
  issuers: { forRequest(request: Request): Promise<TenantJanus | null> };
  /** Counts a user as active in the month (MAU). */
  usage: { recordActive(tenantId: string, userId: string): Promise<void> };
}
