import { denial } from "@softistx/janus-graphql";
import type { Resolvers } from "@/generated/console/resolvers";
import { type Guards, onTenant } from "../../guard";
import type { Role } from "../../model";
import {
  activeTenant,
  assertNotMember,
  members,
  roleOf,
  setRole,
} from "./service";

const GRAPHQL_ROLE = {
  owner: "OWNER",
  admin: "ADMIN",
  viewer: "VIEWER",
} as const satisfies Record<Role, string>;
const ROLE_OF = { OWNER: "owner", ADMIN: "admin", VIEWER: "viewer" } as const;

const tenantArg = (args: Record<string, unknown>) => String(args["tenantId"]);

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
    memberships: async (_, { tenantId }, ctx) =>
      (await members(ctx.access, ctx.directory, tenantId)).map(
        ({ user, role }) => memberOf(user, role),
      ),
    adminInvitations: async (_, { tenantId }, ctx) =>
      (await ctx.admins.invitations(tenantId)).map(invitationOf),
  },
  Mutation: {
    inviteAdmin: async (_, { tenantId, email, role }, ctx) => {
      const tenant = await activeTenant(ctx.directory, tenantId);
      const known = await ctx.admins.userByEmail(email);
      if (known !== null) await assertNotMember(ctx.access, tenantId, known.id);
      const inviter = await ctx.directory.findUser(ctx.principal.userId);
      return invitationOf(
        await ctx.admins.invite({
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
    },
    changeMembership: async (_, { tenantId, userId, role }, ctx) => {
      await activeTenant(ctx.directory, tenantId);
      if ((await roleOf(ctx.access, tenantId, userId)) === null) {
        throw denial("NOT_FOUND", "Not a member of this tenant");
      }
      await setRole(ctx.access, tenantId, userId, ROLE_OF[role]);
      const user = await ctx.directory.findUser(userId);
      if (user === null) throw denial("NOT_FOUND", "No such user");
      return memberOf(user, ROLE_OF[role]);
    },
    removeMembership: async (_, { tenantId, userId }, ctx) => {
      await setRole(ctx.access, tenantId, userId, null);
      return true;
    },
    revokeAdminInvitation: async (_, { tenantId, invitationId }, ctx) => {
      await ctx.admins.revoke(tenantId, invitationId);
      return true;
    },
  },
};
