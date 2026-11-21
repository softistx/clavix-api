import { userScope } from "@/modules/invitations/scope";
import { TenantUnavailableError } from "@/modules/invitations/tenant-invitations";
import type { ConsoleUsers } from "../../context";
import { gone, type Pool } from "./pool";

/** Runs an invitation call, a tenant that went away mid-request being "not found". */
async function invitingly<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof TenantUnavailableError) throw gone();
    throw error;
  }
}

/** The invitations of `ConsoleUsers`: invite, list the pending, revoke. */
export const poolInvitations = ({
  source,
}: Pool): Pick<
  ConsoleUsers,
  "invite" | "invitations" | "revokeInvitation"
> => ({
  async invite({ tenantId, tenantName, email, invitedBy }) {
    const invitation = await invitingly(() =>
      source.invitationsOf(tenantId).invite({
        scope: userScope(),
        organization: tenantName,
        email,
        role: "user",
        invitedBy,
      }),
    );
    return {
      id: invitation.id,
      email: invitation.email,
      invitedAt: invitation.invitedAt,
      expiresAt: invitation.expiresAt,
    };
  },
  async invitations(tenantId) {
    const pending = await invitingly(() =>
      source.invitationsOf(tenantId).pending(userScope()),
    );
    return pending.map(({ id, email, invitedAt, expiresAt }) => ({
      id,
      email,
      invitedAt,
      expiresAt,
    }));
  },
  revokeInvitation: (tenantId, invitationId) =>
    invitingly(() =>
      source.invitationsOf(tenantId).revoke(userScope(), invitationId),
    ),
});
