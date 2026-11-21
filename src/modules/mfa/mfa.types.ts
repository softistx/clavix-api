import type { JanusMail } from "@softistx/janus-mail";
import type { TenantJanus } from "@/modules/users/tenant-janus";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";

/** What `MfaService` is built over: the tenants' janus instances, their mail and the activity counter. */
export interface MfaPorts {
  /** The janus instance of the request's host; `null` for a host that names no active tenant. */
  issuers: { forRequest(request: Request): Promise<TenantJanus | null> };
  /** The e-mails of a tenant, from its own sender. */
  mailOf(tenant: ResolvedTenant): JanusMail;
  /** Counts a user as active in the month (MAU). */
  usage: { recordActive(tenantId: string, userId: string): Promise<void> };
  /** The current time. */
  now: () => Date;
}

/** What a second-factor sign-in of janus-graphql answers. */
export interface SecondFactorDone {
  userId: string;
  expiresAt: string;
  newDevice: boolean;
  recoveryCodesLeft?: number | null;
}

/** The methods a second-factor sign-in is recorded under. */
export type SecondFactorMethod = "totp" | "recoveryCode" | "passkey";
