import { adminTenantOf, isOperatorScope } from "@/invitations/scope";
import type { Access } from "../../access";
import type { Exclusive } from "../../exclusive";
import { isRole } from "../../model";
import { membersKey, roleOf } from "./service";

interface Accepting {
  invitation: { scope: string; role: string };
}

export interface AdminInvitationHooksOptions {
  access: Pick<
    Access,
    "holders" | "grantTenant" | "grantPlatform" | "platformRole"
  >;
  exclusive: Exclusive;
  /** Whether the tenant exists and is active. */
  tenantActive(tenantId: string): Promise<boolean>;
}

/**
 * The janus invitation hooks of the `clavix` tenant. Only an invitation whose
 * scope is an admin one (`adminScope`) or the operator one (`operatorScope`)
 * grants a console role; any other
 * invitation of that tenant is accepted with no grant.
 *
 * `beforeAccept` refuses an admin invitation whose tenant is gone or
 * suspended, or whose role is unknown (nothing is written; the hosted API
 * answers `INVITATION_INVALID`). `onAccepted` grants the role on the tenant;
 * janus claims an invitation once, so it runs once. Someone who already holds
 * a role there keeps it: a role only changes through `changeMembership`.
 */
export function adminInvitationHooks({
  access,
  exclusive,
  tenantActive,
}: AdminInvitationHooksOptions) {
  return {
    async beforeAccept({ invitation }: Accepting): Promise<boolean> {
      if (isOperatorScope(invitation.scope)) return isRole(invitation.role);
      const tenantId = adminTenantOf(invitation.scope);
      if (tenantId === null) return true;
      return isRole(invitation.role) && (await tenantActive(tenantId));
    },
    async onAccepted({
      invitation,
      user,
    }: Accepting & { user: { id: string } }): Promise<void> {
      if (isOperatorScope(invitation.scope)) {
        // An operator invitation (`operators:grant --create`): the platform
        // role, unless the account already holds one (a role only changes
        // through `operators:grant`).
        if (!isRole(invitation.role)) {
          throw new Error(`unknown console role "${invitation.role}"`);
        }
        if ((await access.platformRole(user.id)) === null) {
          await access.grantPlatform(user.id, invitation.role);
        }
        return;
      }
      const tenantId = adminTenantOf(invitation.scope);
      if (tenantId === null) return;
      const { role } = invitation;
      // Throwing releases the invitation: nothing is granted.
      if (!isRole(role)) throw new Error(`unknown console role "${role}"`);
      await exclusive(membersKey(tenantId), async () => {
        if ((await roleOf(access, tenantId, user.id)) === null) {
          await access.grantTenant(tenantId, user.id, role);
        }
      });
    },
  };
}
