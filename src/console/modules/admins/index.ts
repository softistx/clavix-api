import { denial } from "@softistx/janus-graphql";
import type { Resolvers } from "@/generated/console/resolvers";
import type { ConsoleContext } from "../../context";
import type { Role } from "../../model";
import { idArg, liveTenant, tenantIdOf } from "../ids";
import { refusing } from "./errors";

export { adminsAudits, adminsGuards } from "./guards";

import { assertNotMember, changeRole, members, removeMember } from "./service";

const GRAPHQL_ROLE = {
  owner: "OWNER",
  admin: "ADMIN",
  viewer: "VIEWER",
} as const satisfies Record<Role, string>;
const ROLE_OF = { OWNER: "owner", ADMIN: "admin", VIEWER: "viewer" } as const;

// One resend of an invitation at a time (the cooldown check and the write).
const resendKey = (tenantId: string, invitationId: string) =>
  `console:resend:${tenantId}:${invitationId}`;

type StoredInvitation = Awaited<ReturnType<ConsoleContext["admins"]["invite"]>>;

// The inviter by id and display name (the name, else the e-mail): looked up
// once per distinct operator; an account that is gone has no name.
async function invitationsOf(
  ctx: Pick<ConsoleContext, "directory">,
  invitations: StoredInvitation[],
) {
  const names = new Map<string, string | null>();
  for (const { invitedBy } of invitations) {
    if (invitedBy === null || names.has(invitedBy)) continue;
    // A directory failure must not fail a read or a resend already done.
    const user = await ctx.directory.findUser(invitedBy).catch(() => null);
    names.set(invitedBy, user?.name ?? user?.email ?? null);
  }
  return invitations.map(({ invitedBy, ...invitation }) => ({
    ...invitation,
    role: GRAPHQL_ROLE[invitation.role],
    invitedBy:
      invitedBy === null
        ? null
        : { id: invitedBy, name: names.get(invitedBy) ?? null },
  }));
}

const memberOf = (
  user: { id: string; email: string; name?: string | undefined },
  role: Role,
) => ({
  user: { id: user.id, email: user.email, name: user.name ?? null },
  role: GRAPHQL_ROLE[role],
});

const one = async (
  ctx: Pick<ConsoleContext, "directory">,
  invitation: StoredInvitation,
) => {
  const [shaped] = await invitationsOf(ctx, [invitation]);
  if (shaped === undefined) throw new Error("an invitation went missing");
  return shaped;
};

export const admins: Resolvers = {
  Query: {
    // The guard lower-cased the id it checked; read with the same spelling.
    memberships: async (_, { tenantId: given }, ctx) => {
      const tenantId = tenantIdOf(given);
      await liveTenant(ctx.directory, tenantId);
      return (await members(ctx.access, ctx.directory, tenantId)).map(
        ({ user, role }) => memberOf(user, role),
      );
    },
    adminInvitations: async (_, { tenantId: given }, ctx) => {
      const tenantId = tenantIdOf(given);
      await liveTenant(ctx.directory, tenantId);
      return invitationsOf(ctx, await ctx.admins.invitations(tenantId));
    },
  },
  Mutation: {
    inviteAdmin: async (_, { tenantId: given, email, role }, ctx) => {
      const tenantId = tenantIdOf(given);
      const tenant = await liveTenant(ctx.directory, tenantId);
      const known = await ctx.directory.findUserByEmail(email);
      if (known !== null) await assertNotMember(ctx.access, tenantId, known.id);
      await ctx.budgets?.invitation({ tenantId });
      const inviter = await ctx.directory.findUser(ctx.principal.userId);
      const invitation = await ctx.admins.invite({
        tenantId,
        tenantName: tenant.name,
        email,
        role: ROLE_OF[role],
        invitedBy: {
          id: ctx.principal.userId,
          name: inviter?.name ?? inviter?.email,
        },
      });
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
    resendAdminInvitation: async (
      _,
      { tenantId: given, invitationId },
      ctx,
    ) => {
      const tenantId = tenantIdOf(given);
      idArg(invitationId, "invitationId");
      const tenant = await liveTenant(ctx.directory, tenantId);
      const sender = await ctx.directory.findUser(ctx.principal.userId);
      const resent = await ctx.exclusive(
        resendKey(tenantId, invitationId),
        () =>
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
    revokeAdminInvitation: async (
      _,
      { tenantId: given, invitationId },
      ctx,
    ) => {
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
  },
};
