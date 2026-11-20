import type { CoreContext } from "@graxia/core";
import type { OAuthUserPrincipal } from "@softistx/janus-oauth";
import type { AuthEventsService } from "@/modules/audit/auth-events.service";
import type { PlanId } from "@/modules/tenants/plan.schema";
import type { Access } from "./access";
import type { AdminEventReader } from "./admin-events/reader";
import type { Audit } from "./audit";
import type { ConsoleBudgets } from "./budgets";
import type { Exclusive } from "./exclusive";
import type { Permission, Role } from "./model";

/** What the console needs to look a user or tenants up, injected (see `src/config/console.ts`). */
export interface ConsoleDirectory {
  /** A user of the `clavix` tenant, or `null` (gone, deactivated). */
  findUser(id: string): Promise<{
    id: string;
    email: string;
    name?: string | undefined;
    /** Whether the user can sign in (a disabled one cannot). */
    active: boolean;
  } | null>;
  /**
   * Whether the `clavix` user's e-mail is proved; `false` for an unknown user.
   * The console refuses an unproved caller (ADR-0041).
   */
  emailVerified(id: string): Promise<boolean>;
  /** A user of the `clavix` tenant by e-mail, or `null`. */
  findUserByEmail(email: string): Promise<{ id: string } | null>;
  /**
   * The active and suspended tenants with these ids (hex), in any order; an
   * unknown or trashed id is left out. A suspended tenant stays readable by
   * its admins (ADR-0039), its writes being refused by the guard.
   */
  tenantsByIds(ids: readonly string[]): Promise<
    {
      id: string;
      slug: string;
      name: string;
      status: "active" | "suspended";
      /** The plan, which sets how long the activity logs are kept (D16). */
      plan: PlanId;
    }[]
  >;
}

/** A pending admin invitation of a tenant, as the console shows it. */
export interface AdminInvitation {
  id: string;
  email: string;
  role: Role;
  invitedAt: Date;
  expiresAt: Date;
  /** The id of the operator who invited; `null` when the system did (a script). */
  invitedBy: string | null;
}

/**
 * The admin invitations of the tenants: invitations of the `clavix` tenant,
 * one scope per managed tenant. Injected (see `src/config/console.ts`).
 */
export interface ConsoleAdmins {
  /** Issues the invitation (a pending one for the same address is replaced) and mails it. */
  invite(input: {
    tenantId: string;
    tenantName: string;
    email: string;
    role: Role;
    invitedBy: { id: string; name?: string | undefined };
  }): Promise<AdminInvitation>;
  /** The pending, unlapsed invitations of the tenant. */
  invitations(tenantId: string): Promise<AdminInvitation[]>;
  /**
   * Sends one of the tenant's pending invitations again: a new code and
   * lifetime, a new mail. Throws `ResendRefusedError` (not found, not pending,
   * sent less than a minute ago).
   */
  resend(input: {
    tenantId: string;
    tenantName: string;
    invitationId: string;
    by: { id: string; name?: string | undefined };
  }): Promise<AdminInvitation>;
  /** Revokes one of the tenant's invitations; `false` when it is not a pending one of this tenant. */
  revoke(tenantId: string, invitationId: string): Promise<boolean>;
}

/** An end user of a tenant, as the console shows it. */
export interface TenantUserView {
  id: string;
  email: string;
  name?: string | undefined;
  emailVerified: boolean;
  active: boolean;
  createdAt: Date;
}

/** One standing session of a user, without its token. */
export interface UserSessionView {
  id: string;
  /** The `deviceLabel` the sign-in recorded (the User-Agent); absent on an older session. */
  device?: string | undefined;
  createdAt: Date;
  authenticatedAt: Date;
  /** Moves when the session is renewed; absent on an older session. */
  lastUsedAt?: Date | undefined;
  expiresAt: Date;
}

/** One standing OAuth grant of a user. */
export interface UserGrantView {
  id: string;
  clientId: string;
  clientName: string | null;
  resource: string;
  scopes: readonly string[];
  createdAt: Date;
  updatedAt: Date;
}

/** A pending invitation into a tenant's user pool. */
export interface UserInvitationView {
  id: string;
  email: string;
  invitedAt: Date;
  expiresAt: Date;
}

/** A user's TOTP factor as the console may know it: never the secret or the codes. */
export interface UserSecondFactorView {
  enabled: boolean;
  recoveryCodesLeft: number | null;
}

/**
 * The end users of the tenants (their janus partition), their invitations and
 * grants. Every call names a tenant that is not in the trash (active or suspended) by id (the caller checked it);
 * a user or id of another tenant is unknown. Injected (see `src/config/console.ts`).
 */
export interface ConsoleUsers {
  /**
   * One page, oldest first. `emailPrefix` keeps the users whose login starts
   * with it, in any case. A cursor janus refuses rejects with `INVALID_CURSOR`.
   */
  list(
    tenantId: string,
    page: { after: string | null; limit: number; emailPrefix?: string },
  ): Promise<{ items: TenantUserView[]; nextCursor: string | null }>;
  /** How many users the tenant has, or those `emailPrefix` keeps. */
  count(tenantId: string, filter?: { emailPrefix?: string }): Promise<number>;
  /**
   * Up to `limit` users whose login (e-mail or username) or display name
   * starts with `query` (any case), logins first, each once. Names are read
   * from the oldest users only (a bounded scan).
   */
  lookup(
    tenantId: string,
    query: string,
    limit: number,
  ): Promise<TenantUserView[]>;
  find(tenantId: string, id: string): Promise<TenantUserView | null>;
  findByEmail(tenantId: string, email: string): Promise<TenantUserView | null>;
  /** The user as written, or `null` when unknown. Disabling ends the user's sessions. */
  setActive(
    tenantId: string,
    id: string,
    active: boolean,
  ): Promise<TenantUserView | null>;
  /** Sets the display name; the user as written, or `null` when unknown. */
  rename(
    tenantId: string,
    id: string,
    name: string,
  ): Promise<TenantUserView | null>;
  /** Sets or clears the verified flag only; the user as written, or `null` when unknown. */
  setEmailVerified(
    tenantId: string,
    id: string,
    verified: boolean,
  ): Promise<TenantUserView | null>;
  /** The user's TOTP factor; `enabled: false` for a user with none (or an unknown one). */
  secondFactor(tenantId: string, id: string): Promise<UserSecondFactorView>;
  /**
   * `secondFactor` for several users of one tenant, in the order of `ids`:
   * one read of the records, then the recovery codes of the holders only
   * (the `TenantUser.secondFactor` loader of a page).
   */
  secondFactors(
    tenantId: string,
    ids: readonly string[],
  ): Promise<UserSecondFactorView[]>;
  /**
   * Removes the user's TOTP factor and recovery codes (a lost phone and lost
   * codes); the user as written, or `null` when unknown. Idempotent.
   */
  resetSecondFactor(
    tenantId: string,
    id: string,
  ): Promise<TenantUserView | null>;
  /** Ends every session; answers how many. */
  revokeSessions(tenantId: string, id: string): Promise<number>;
  /** The user's standing sessions, newest first; empty for an unknown user. */
  sessions(tenantId: string, id: string): Promise<UserSessionView[]>;
  /** `false` when the session is not this user's, is gone, or already revoked. */
  revokeSession(
    tenantId: string,
    id: string,
    sessionId: string,
  ): Promise<boolean>;
  /** Deletes the user, their sessions and grants; `false` when already gone. */
  delete(tenantId: string, id: string): Promise<boolean>;
  invite(input: {
    tenantId: string;
    tenantName: string;
    email: string;
    invitedBy: { id: string; name?: string | undefined };
  }): Promise<UserInvitationView>;
  invitations(tenantId: string): Promise<UserInvitationView[]>;
  /** `false` when it is not a pending one of this tenant. */
  revokeInvitation(tenantId: string, invitationId: string): Promise<boolean>;
  grants(tenantId: string, userId: string): Promise<UserGrantView[]>;
  /** `false` when the grant is not this user's or does not exist. */
  revokeGrant(
    tenantId: string,
    userId: string,
    grantId: string,
  ): Promise<boolean>;
}

/** What the console's plugin puts on every context, for a request whose bearer token was accepted. */
export interface ConsoleExtras {
  /** Who the token belongs to (the user, the client, its scopes). */
  readonly principal: OAuthUserPrincipal;
  /** Whether the caller has `permission` on the tenant; a denial is `false`. */
  can(permission: Permission, tenantId: string): Promise<boolean>;
  /** Whether the caller has `permission` on the platform itself. */
  canPlatform(permission: Permission): Promise<boolean>;
  /**
   * Records what the caller just did (an admin event, ADR-0037). Every
   * mutation awaits it once its change is stored: a failed record fails the
   * mutation. Identifiers only, never a secret value.
   */
  audit: Audit;
  readonly access: Access;
  readonly directory: ConsoleDirectory;
  readonly admins: ConsoleAdmins;
  readonly users: ConsoleUsers;
  /** One at a time per key (a tenant's memberships). */
  readonly exclusive: Exclusive;
  /** What the test webhooks and the invitations spend; `undefined`: no budget (no Redis). */
  readonly budgets: ConsoleBudgets | undefined;
  /** The readers of the two logs (D12): the console's activity and the tenants' sign-ins. */
  readonly activity: ConsoleActivity;
}

/** What the audit module reads: both logs, through their own services. */
export interface ConsoleActivity {
  readonly admin: AdminEventReader;
  readonly auth: AuthEventsService;
}

/** A console resolver's context. The generated `Resolvers` takes it (codegen.console.ts). */
export type ConsoleContext = CoreContext & {
  readonly request: Request;
} & ConsoleExtras;
