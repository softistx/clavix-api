import type { OAuthPrincipal } from "@softistx/janus-oauth";
import type { YogaInitialContext } from "graphql-yoga";
import type { Access } from "./access";
import type { Audit } from "./audit";
import type { Exclusive } from "./exclusive";
import type { Permission, Role } from "./model";

/** What the console needs to look a user or tenants up, injected (see `src/config/console.ts`). */
export interface ConsoleDirectory {
  /** A user of the `clavix` tenant, or `null` (gone, deactivated). */
  findUser(
    id: string,
  ): Promise<{ id: string; email: string; name?: string | undefined } | null>;
  /** A user of the `clavix` tenant by e-mail, or `null`. */
  findUserByEmail(email: string): Promise<{ id: string } | null>;
  /** The active tenants with these ids (hex), in any order; unknown ids are left out. */
  tenantsByIds(
    ids: readonly string[],
  ): Promise<{ id: string; slug: string; name: string }[]>;
}

/** A pending admin invitation of a tenant, as the console shows it. */
export interface AdminInvitation {
  id: string;
  email: string;
  role: Role;
  invitedAt: Date;
  expiresAt: Date;
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
  /** Revokes one of the tenant's invitations; `false` when it is not a pending one of this tenant. */
  revoke(tenantId: string, invitationId: string): Promise<boolean>;
}

/** What the console's plugin puts on every context, for a request whose bearer token was accepted. */
export interface ConsoleExtras {
  /** Who the token belongs to (the user, the client, its scopes). */
  readonly principal: OAuthPrincipal;
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
  /** One at a time per key (a tenant's memberships). */
  readonly exclusive: Exclusive;
}

/** A console resolver's context. The generated `Resolvers` takes it (codegen.console.ts). */
export type ConsoleContext = YogaInitialContext & ConsoleExtras;
