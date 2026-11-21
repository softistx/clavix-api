import { InvitationInvalidError } from "@softistx/janus";
import {
  adminTenantOf,
  isOperatorScope,
} from "@/modules/invitations/invitations.rules";
import type { Access } from "../../access";
import type { Exclusive } from "../../exclusive";
import { isRole } from "../../model";
import { membersKey, roleOf } from "./service";

interface Accepting {
  invitation: { scope: string; role: string; invitedBy?: string | null };
}

export interface AdminInvitationHooksOptions {
  access: Pick<
    Access,
    "holders" | "grantTenant" | "grantPlatform" | "platformRole"
  >;
  exclusive: Exclusive;
  /**
   * The `Exclusive` key of a user of the `clavix` tenant (`userKey`), the one
   * `deleteUser` holds while it removes the account and sweeps its roles.
   */
  userLock(userId: string): string;
  /** Whether the tenant exists and is active. */
  tenantActive(tenantId: string): Promise<boolean>;
  /** A user of the `clavix` tenant, or `null` when gone; `active` is false once disabled. */
  findUser(id: string): Promise<{ active: boolean } | null>;
}

/**
 * The janus invitation hooks of the `clavix` tenant. Only an invitation whose
 * scope is an admin one (`adminScope`) or the operator one (`operatorScope`)
 * grants a console role; any other
 * invitation of that tenant is accepted with no grant.
 *
 * `beforeAccept` refuses an admin invitation whose tenant is gone or
 * suspended, or whose role is unknown, and an `owner` invitation whose
 * inviter was deleted or disabled since (nothing is written; the hosted API answers
 * `INVITATION_INVALID`). `onAccepted` grants the role on the tenant;
 * janus claims an invitation once, so it runs once. An `owner` is never
 * granted to an account that was deleted or disabled meanwhile (no ghost
 * owner): it throws, and the invitation is released. Someone who already holds
 * a role there keeps it: a role only changes through `changeMembership`.
 *
 * The grant runs under the user's lock (`userLock`), inside the tenant's
 * members lock for a tenant role: the order of `keepOwners`, members then
 * user. It is then serialised with `deleteUser`: an account deleted meanwhile
 * is found gone and gets no role (any role; an owner also needs it active),
 * and one granted just before is swept by the delete.
 */
export function adminInvitationHooks({
  access,
  exclusive,
  userLock,
  tenantActive,
  findUser,
}: AdminInvitationHooksOptions) {
  /**
   * No role goes to a ghost: the account must exist, and an owner must also be
   * active. Called under the user's lock, so a `deleteUser` is not half done.
   */
  const assertLive = async (userId: string, role: string) => {
    const found = await findUser(userId);
    if (found === null || (role === "owner" && !found.active)) {
      // A janus refusal: the hosted API answers `INVITATION_INVALID` (400),
      // not a 500, and the claim is released.
      throw new InvitationInvalidError(
        "the account is gone or disabled: no owner is granted",
      );
    }
  };
  /** An owner invitation does not outlive its inviter: not accepted once they are gone or disabled. */
  const inviterGone = async ({ invitation }: Accepting) =>
    invitation.role === "owner" &&
    typeof invitation.invitedBy === "string" &&
    (await findUser(invitation.invitedBy))?.active !== true;
  return {
    async beforeAccept(accepting: Accepting): Promise<boolean> {
      const { invitation } = accepting;
      if (await inviterGone(accepting)) return false;
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
        const { role } = invitation;
        await exclusive(userLock(user.id), async () => {
          await assertLive(user.id, role);
          if ((await access.platformRole(user.id)) === null) {
            await access.grantPlatform(user.id, role);
          }
        });
        return;
      }
      const tenantId = adminTenantOf(invitation.scope);
      if (tenantId === null) return;
      const { role } = invitation;
      // Throwing releases the invitation: nothing is granted.
      if (!isRole(role)) throw new Error(`unknown console role "${role}"`);
      await exclusive(membersKey(tenantId), () =>
        exclusive(userLock(user.id), async () => {
          await assertLive(user.id, role);
          if ((await roleOf(access, tenantId, user.id)) === null) {
            await access.grantTenant(tenantId, user.id, role);
          }
        }),
      );
    },
  };
}
