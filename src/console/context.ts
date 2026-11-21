import type { CoreContext } from "@softistx/graxia";
import type { OAuthUserPrincipal } from "@softistx/janus-oauth";
import type { AdminsService } from "@/modules/admins/admins.service";
import type { AuditService } from "@/modules/audit/audit.service";
import type { PlanId } from "@/modules/tenants";
import type { Access } from "./access";
import type { AdminEventReader } from "./admin-events/reader";
import type { Audit } from "./audit";
import type { ConsoleBudgets } from "./budgets";
import type { Exclusive } from "./exclusive";
import type { Permission, Role } from "./model";
import type { ConsoleUsers } from "./users-context";

export type {
  ConsoleUsers,
  TenantUserView,
  UserGrantView,
  UserInvitationView,
  UserSecondFactorView,
  UserSessionView,
} from "./users-context";

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
  /** The memberships: who holds which role, and their writes (the one owner rule). */
  readonly members: AdminsService;
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
  readonly auth: AuditService;
}

/** A console resolver's context. The generated `Resolvers` takes it (codegen.console.ts). */
export type ConsoleContext = CoreContext & {
  readonly request: Request;
} & ConsoleExtras;
