import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import type { Resolvers } from "@/generated/console/resolvers";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import type { Role } from "../../model";
import { activeTenant } from "../directory-tenant";
import { assertNotMember, changeRole, members, removeMember } from "./service";

const GRAPHQL_ROLE = {
  owner: "OWNER",
  admin: "ADMIN",
  viewer: "VIEWER",
} as const satisfies Record<Role, string>;
const ROLE_OF = { OWNER: "owner", ADMIN: "admin", VIEWER: "viewer" } as const;

// Lower-cased here as in `tenantIdOf`: the guard and the resolver act on the
// same id, whatever case the caller sent.
const tenantArg = (args: Record<string, unknown>) =>
  String(args["tenantId"]).toLowerCase();

// Reading the admins is `view`; changing them is `manage` (the tenant's owner,
// or a platform owner): an admin or a viewer cannot grant roles.
export const adminsGuards: Guards = {
  "Query.memberships": onTenant("view", tenantArg),
  "Query.adminInvitations": onTenant("view", tenantArg),
  "Mutation.inviteAdmin": onTenant("manage", tenantArg),
  "Mutation.changeMembership": onTenant("manage", tenantArg),
  "Mutation.removeMembership": onTenant("manage", tenantArg),
  "Mutation.revokeAdminInvitation": onTenant("manage", tenantArg),
};

// One event per mutation, recorded once its change is stored. A repeat records
// again (a removal of a non-member, a revocation of nothing): the retry of a
// call whose record failed must not leave the change with no event.
export const adminsAudits: Audits = {
  "Mutation.inviteAdmin": "membership.invite",
  "Mutation.changeMembership": "membership.change",
  "Mutation.removeMembership": "membership.remove",
  "Mutation.revokeAdminInvitation": "membership.revokeInvitation",
};

// The guard decided who may touch the tenant; this decides the id has a
// tenant's form, in the one spelling the relations and the trail use.
function tenantIdOf(given: string) {
  if (!/^[0-9a-f]{24}$/i.test(given)) {
    throw denial("NOT_FOUND", "No such tenant");
  }
  return given.toLowerCase();
}

// An id the trail can name (an event's target id holds 200 characters at
// most): refused before anything is written, never after.
function targetId(given: string, name: string) {
  if (given.length === 0 || given.length > 200) {
    throw new GraphQLError(`${name} is not an id`, {
      extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
    });
  }
  return given;
}

const invitationOf = (invitation: {
  id: string;
  email: string;
  role: Role;
  invitedAt: Date;
  expiresAt: Date;
}) => ({ ...invitation, role: GRAPHQL_ROLE[invitation.role] });

const memberOf = (
  user: { id: string; email: string; name?: string | undefined },
  role: Role,
) => ({
  user: { id: user.id, email: user.email, name: user.name ?? null },
  role: GRAPHQL_ROLE[role],
});

export const admins: Resolvers = {
  Query: {
    // The guard lower-cased the id it checked; read with the same spelling.
    memberships: async (_, { tenantId }, ctx) =>
      (await members(ctx.access, ctx.directory, tenantIdOf(tenantId))).map(
        ({ user, role }) => memberOf(user, role),
      ),
    adminInvitations: async (_, { tenantId }, ctx) =>
      (await ctx.admins.invitations(tenantIdOf(tenantId))).map(invitationOf),
  },
  Mutation: {
    inviteAdmin: async (_, { tenantId: given, email, role }, ctx) => {
      const tenantId = tenantIdOf(given);
      const tenant = await activeTenant(ctx.directory, tenantId);
      const known = await ctx.directory.findUserByEmail(email);
      if (known !== null) await assertNotMember(ctx.access, tenantId, known.id);
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
      return invitationOf(invitation);
    },
    changeMembership: async (_, { tenantId: given, userId, role }, ctx) => {
      const tenantId = tenantIdOf(given);
      targetId(userId, "userId");
      await activeTenant(ctx.directory, tenantId);
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
      targetId(userId, "userId");
      // Like the other writes: a tenant that is gone or suspended is not edited.
      await activeTenant(ctx.directory, tenantId);
      await removeMember(ctx, tenantId, userId);
      await ctx.audit("membership.remove", {
        type: "user",
        id: userId,
        tenantId,
      });
      return true;
    },
    revokeAdminInvitation: async (
      _,
      { tenantId: given, invitationId },
      ctx,
    ) => {
      const tenantId = tenantIdOf(given);
      targetId(invitationId, "invitationId");
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
