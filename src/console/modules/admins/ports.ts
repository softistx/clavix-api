import type { Role } from "../../model";

/** A pending admin invitation of a tenant, as the console shows it. */
export interface AdminInvitation {
  id: string;
  email: string;
  role: Role;
  invitedAt: Date;
  expiresAt: Date;
}

/**
 * What the admins of a tenant need beyond the relations: the `clavix` tenant's
 * invitations (scope = the managed tenant's id) and its user lookup by e-mail.
 * Injected (see `src/config/console.ts`).
 */
export interface ConsoleAdmins {
  /** A user of the `clavix` tenant by e-mail, or `null`. */
  userByEmail(email: string): Promise<{ id: string } | null>;
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
