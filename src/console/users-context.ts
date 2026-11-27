// The console users port and the views it answers (split from `context.ts`).

import type { ProfileChanges, ProfileView } from "@/modules/profile";

/** An end user of a tenant, as the console shows it. */
export interface TenantUserView {
  id: string;
  email: string;
  name?: string | undefined;
  emailVerified: boolean;
  active: boolean;
  createdAt: Date;
  /** The standard profile fields (`null` for one not set). */
  profile: ProfileView;
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
  /**
   * `find` for several users of one tenant, in the order of `ids`, `null` for
   * an unknown one: one read of the records (the role members loader).
   */
  findMany(
    tenantId: string,
    ids: readonly string[],
  ): Promise<(TenantUserView | null)[]>;
  findByEmail(tenantId: string, email: string): Promise<TenantUserView | null>;
  /** The user as written, or `null` when unknown. Disabling ends the user's sessions. */
  setActive(
    tenantId: string,
    id: string,
    active: boolean,
  ): Promise<TenantUserView | null>;
  /**
   * Applies a checked profile change (the display name and the standard
   * fields) in one version-checked write; the user as written, or `null` when
   * unknown. A phone number that changes starts unverified.
   */
  update(
    tenantId: string,
    id: string,
    changes: ProfileChanges,
  ): Promise<TenantUserView | null>;
  /**
   * Marks the user's phone proved (or not); `null` when the user is unknown,
   * `PROFILE_FIELD_INVALID` is the caller's when the user has no phone.
   */
  setPhoneVerified(
    tenantId: string,
    id: string,
    verified: boolean,
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
  /**
   * Removes the user's picture: `true` when this call removed one, `false`
   * when there was none; `null` for an unknown user.
   */
  removePicture(tenantId: string, id: string): Promise<boolean | null>;
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
