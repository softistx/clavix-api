import { JanusError } from "@softistx/janus";
import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import type { Resolvers } from "@/generated/console/resolvers";
import type { Audits } from "../../audit";
import type {
  ConsoleContext,
  TenantUserView,
  UserGrantView,
} from "../../context";
import { type Guards, onTenant } from "../../guard";
import { activeTenant } from "../admins/service";

// Lower-cased as in the admins module: the guard and the resolver act on the
// same id, whatever case the caller sent.
const tenantArg = (args: Record<string, unknown>) =>
  String(args["tenantId"]).toLowerCase();

// Reading the users is `view`; changing them is `edit` (a tenant admin).
export const usersGuards: Guards = {
  "Query.users": onTenant("view", tenantArg),
  "Query.user": onTenant("view", tenantArg),
  "Query.userInvitations": onTenant("view", tenantArg),
  "Query.userGrants": onTenant("view", tenantArg),
  "Mutation.inviteUser": onTenant("edit", tenantArg),
  "Mutation.revokeInvitation": onTenant("edit", tenantArg),
  "Mutation.disableUser": onTenant("edit", tenantArg),
  "Mutation.enableUser": onTenant("edit", tenantArg),
  "Mutation.deleteUser": onTenant("edit", tenantArg),
  "Mutation.revokeUserSessions": onTenant("edit", tenantArg),
  "Mutation.revokeGrant": onTenant("edit", tenantArg),
};

// One event per mutation, recorded once its change is stored. A repeat records
// again: the retry of a call whose record failed must not leave the change
// with no event. Targets are ids, never an address.
export const usersAudits: Audits = {
  "Mutation.inviteUser": "user.invite",
  "Mutation.revokeInvitation": "user.revokeInvitation",
  "Mutation.disableUser": "user.disable",
  "Mutation.enableUser": "user.enable",
  "Mutation.deleteUser": "user.delete",
  "Mutation.revokeUserSessions": "user.revokeSessions",
  "Mutation.revokeGrant": "user.revokeGrant",
};

function tenantIdOf(given: string) {
  if (!/^[0-9a-f]{24}$/i.test(given)) {
    throw denial("NOT_FOUND", "No such tenant");
  }
  return given.toLowerCase();
}

// An id the trail can name (200 characters at most): refused before anything is written.
function idArg(given: string, name: string) {
  if (given.length === 0 || given.length > 200) {
    throw new GraphQLError(`${name} is not an id`, {
      extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
    });
  }
  return given;
}

const shape = (user: TenantUserView) => ({
  id: user.id,
  email: user.email,
  name: user.name ?? null,
  emailVerified: user.emailVerified,
  active: user.active,
  createdAt: user.createdAt,
});

const grantShape = (grant: UserGrantView) => ({
  ...grant,
  scopes: [...grant.scopes],
});

const MAX_PAGE = 100;
const target = (type: string, id: string, tenantId: string) => ({
  type,
  id,
  tenantId,
});

export const users: Resolvers = {
  Query: {
    users: async (_, { tenantId: given, after, first, email }, ctx) => {
      const tenantId = tenantIdOf(given);
      await activeTenant(ctx.directory, tenantId);
      if (email !== null && email !== undefined) {
        const found = await ctx.users.findByEmail(tenantId, email);
        return {
          items: found === null ? [] : [shape(found)],
          nextCursor: null,
        };
      }
      try {
        const page = await ctx.users.list(tenantId, {
          after: after ?? null,
          limit: Math.min(Math.max(first ?? 25, 1), MAX_PAGE),
        });
        return { items: page.items.map(shape), nextCursor: page.nextCursor };
      } catch (error) {
        if (error instanceof JanusError && error.code === "INVALID_CURSOR") {
          throw new GraphQLError("The cursor is not valid", {
            extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
          });
        }
        throw error;
      }
    },
    user: async (_, { tenantId: given, id }, ctx) => {
      const tenantId = tenantIdOf(given);
      await activeTenant(ctx.directory, tenantId);
      const found = await ctx.users.find(tenantId, id);
      return found === null ? null : shape(found);
    },
    userInvitations: async (_, { tenantId: given }, ctx) => {
      const tenantId = tenantIdOf(given);
      await activeTenant(ctx.directory, tenantId);
      return ctx.users.invitations(tenantId);
    },
    userGrants: async (_, { tenantId: given, userId }, ctx) => {
      const tenantId = tenantIdOf(given);
      await activeTenant(ctx.directory, tenantId);
      return (await ctx.users.grants(tenantId, userId)).map(grantShape);
    },
  },
  Mutation: {
    inviteUser: async (_, { tenantId: given, email }, ctx) => {
      const tenantId = tenantIdOf(given);
      const tenant = await activeTenant(ctx.directory, tenantId);
      if ((await ctx.users.findByEmail(tenantId, email)) !== null) {
        throw new GraphQLError("This address already has an account", {
          extensions: { code: "USER_EXISTS", http: { status: 409 } },
        });
      }
      const inviter = await ctx.directory.findUser(ctx.principal.userId);
      const invitation = await ctx.users.invite({
        tenantId,
        tenantName: tenant.name,
        email,
        invitedBy: {
          id: ctx.principal.userId,
          name: inviter?.name ?? inviter?.email,
        },
      });
      await ctx.audit(
        "user.invite",
        target("invitation", invitation.id, tenantId),
      );
      return invitation;
    },
    revokeInvitation: async (_, { tenantId: given, invitationId }, ctx) => {
      const tenantId = tenantIdOf(given);
      idArg(invitationId, "invitationId");
      await activeTenant(ctx.directory, tenantId);
      await ctx.users.revokeInvitation(tenantId, invitationId);
      await ctx.audit(
        "user.revokeInvitation",
        target("invitation", invitationId, tenantId),
      );
      return true;
    },
    disableUser: (_, { tenantId, userId }, ctx) =>
      setActive(ctx, tenantId, userId, false),
    enableUser: (_, { tenantId, userId }, ctx) =>
      setActive(ctx, tenantId, userId, true),
    deleteUser: async (_, { tenantId: given, userId }, ctx) => {
      const tenantId = tenantIdOf(given);
      idArg(userId, "userId");
      await activeTenant(ctx.directory, tenantId);
      await ctx.users.delete(tenantId, userId);
      await ctx.audit("user.delete", target("user", userId, tenantId));
      return true;
    },
    revokeUserSessions: async (_, { tenantId: given, userId }, ctx) => {
      const tenantId = tenantIdOf(given);
      idArg(userId, "userId");
      await activeTenant(ctx.directory, tenantId);
      const ended = await ctx.users.revokeSessions(tenantId, userId);
      await ctx.audit("user.revokeSessions", target("user", userId, tenantId));
      return ended;
    },
    revokeGrant: async (_, { tenantId: given, userId, grantId }, ctx) => {
      const tenantId = tenantIdOf(given);
      idArg(userId, "userId");
      idArg(grantId, "grantId");
      await activeTenant(ctx.directory, tenantId);
      const revoked = await ctx.users.revokeGrant(tenantId, userId, grantId);
      // Recorded on a repeat and on a grant that is not this user's too:
      // the id is only named, never read.
      await ctx.audit("user.revokeGrant", target("grant", grantId, tenantId));
      return revoked;
    },
  },
};

async function setActive(
  ctx: ConsoleContext,
  given: string,
  userId: string,
  active: boolean,
) {
  const tenantId = tenantIdOf(given);
  idArg(userId, "userId");
  await activeTenant(ctx.directory, tenantId);
  const user = await ctx.users.setActive(tenantId, userId, active);
  if (user === null) throw denial("NOT_FOUND", "No such user");
  await ctx.audit(
    active ? "user.enable" : "user.disable",
    target("user", userId, tenantId),
  );
  return shape(user);
}
