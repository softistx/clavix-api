import type { JanusMail } from "@softistx/janus-mail";
import type { TenantJanus } from "@/modules/users/tenant-janus";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";

/** What `AuthService` is built over: the tenants' janus instances, their mail and the activity counter. */
export interface AuthPorts {
  /** The janus instance of the request's host; `null` for a host that names no active tenant. */
  issuers: { forRequest(request: Request): Promise<TenantJanus | null> };
  /** The e-mails of a tenant, from its own sender. */
  mailOf(tenant: ResolvedTenant): JanusMail;
  /** Counts a user as active in the month (MAU). */
  usage: { recordActive(tenantId: string, userId: string): Promise<void> };
  /** The current time. */
  now: () => Date;
  /** Where a mail that was not sent is logged (by its error name only). */
  log: (message: string) => void;
}

/** The outcome of a sign-in step that may stop at a second factor. */
export type SignInDone = Awaited<
  ReturnType<TenantJanus["signInCode"]["confirm"]>
>;
