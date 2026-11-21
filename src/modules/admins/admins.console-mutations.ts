import { denial } from "@softistx/janus-graphql";
import { idArg, liveTenant, tenantIdOf } from "@/console/modules/ids";
import type { Resolvers } from "@/generated/console/resolvers";
import { one } from "./admins.console-support";
import { refusing } from "./admins.errors";
import { assertNotMember, changeRole, removeMember } from "./admins.service";
import { memberOf, ROLE_OF, resendKey } from "./admins.utils";

export const adminsMutations: NonNullable<Resolvers["Mutation"]> = {
  inviteAdmin: async (_, { tenantId: given, email, role }, ctx) => {
    const tenantId = tenantIdOf(given);
    const tenant = await liveTenant(ctx.directory, tenantId);
    const known = await ctx.directory.findUserByEmail(email);
    if (known !== null) await assertNotMember(ctx.access, tenantId, known.id);
    await ctx.budgets?.invitation({ tenantId });
    const inviter = await ctx.directory.findUser(ctx.principal.userId);
    const invitation = await refusing(() =>
      ctx.admins.invite({
        tenantId,
        tenantName: tenant.name,
        email,
        role: ROLE_OF[role],
        invitedBy: {
          id: ctx.principal.userId,
          name: inviter?.name ?? inviter?.email,
        },
      }),
    );
    // The invitation's id, never the address or the code.
    await ctx.audit("membership.invite", {
      type: "invitation",
      id: invitation.id,
      tenantId,
    });
    return one(ctx, invitation);
  },
  changeMembership: async (_, { tenantId: given, userId, role }, ctx) => {
    const tenantId = tenantIdOf(given);
    idArg(userId, "userId");
    await liveTenant(ctx.directory, tenantId);
    // Before any write: a refusal leaves no change and no event.
    const user = await ctx.directory.findUser(userId);
    if (user === null) throw denial("NOT_FOUND", "No such user");
    const stored = await changeRole(ctx, tenantId, userId, ROLE_OF[role]);
    await ctx.audit("membership.change", {
      type: "user",
      id: userId,
      tenantId,
    });
    return memberOf(user, stored);
  },
  removeMembership: async (_, { tenantId: given, userId }, ctx) => {
    const tenantId = tenantIdOf(given);
    idArg(userId, "userId");
    // Like the other writes: a tenant that is gone (or trashed) is not edited; a suspended one is refused by the guard.
    await liveTenant(ctx.directory, tenantId);
    await removeMember(ctx, tenantId, userId);
    await ctx.audit("membership.remove", {
      type: "user",
      id: userId,
      tenantId,
    });
    return true;
  },
  resendAdminInvitation: async (_, { tenantId: given, invitationId }, ctx) => {
    const tenantId = tenantIdOf(given);
    idArg(invitationId, "invitationId");
    const tenant = await liveTenant(ctx.directory, tenantId);
    const sender = await ctx.directory.findUser(ctx.principal.userId);
    const resent = await ctx.exclusive(resendKey(tenantId, invitationId), () =>
      refusing(() =>
        ctx.admins.resend({
          tenantId,
          tenantName: tenant.name,
          invitationId,
          by: {
            id: ctx.principal.userId,
            name: sender?.name ?? sender?.email,
          },
        }),
      ),
    );
    // Recorded once the new code is out; a refusal stores nothing.
    await ctx.audit("membership.resendInvitation", {
      type: "invitation",
      id: invitationId,
      tenantId,
    });
    return one(ctx, resent);
  },
  revokeAdminInvitation: async (_, { tenantId: given, invitationId }, ctx) => {
    const tenantId = tenantIdOf(given);
    idArg(invitationId, "invitationId");
    await ctx.admins.revoke(tenantId, invitationId);
    await ctx.audit("membership.revokeInvitation", {
      type: "invitation",
      id: invitationId,
      tenantId,
    });
    return true;
  },
};
