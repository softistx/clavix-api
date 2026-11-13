import type { Access } from "../../access";
import { ROLES, type Role } from "../../model";

const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);

/**
 * `invitations.onAccepted` of the `clavix` tenant: grants the invited role on
 * the tenant the invitation's scope names. janus claims an invitation once, so
 * this runs once per invitation; the grant itself is idempotent. A role it
 * does not know throws, which releases the invitation (nothing is granted).
 */
export const adminAccepted =
  (access: Pick<Access, "grantTenant">) =>
  async (accepted: {
    invitation: { scope: string; role: string };
    user: { id: string };
  }) => {
    const { scope, role } = accepted.invitation;
    if (!isRole(role)) throw new Error(`unknown console role "${role}"`);
    await access.grantTenant(scope, accepted.user.id, role);
  };
