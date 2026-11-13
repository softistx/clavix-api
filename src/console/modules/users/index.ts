import { JanusError } from "@softistx/janus";
import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import { ObjectId } from "mongodb";
import { rolesService } from "@/config/roles";
import type { Resolvers } from "@/generated/console/resolvers";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import type { Audits } from "../../audit";
import type {
  ConsoleContext,
  TenantUserView,
  UserGrantView,
} from "../../context";
import { type Guards, onTenant } from "../../guard";
import { activeTenant } from "../directory-tenant";
import { idArg, lowerTenantArg, tenantIdOf } from "../ids";
import { userKey } from "../user-key";
import { keepOwners } from "./operators";

// Reading the users is `view`; changing them is `edit` (a tenant admin).
export const usersGuards: Guards = {
  "Query.users": onTenant("view", lowerTenantArg),
  "Query.user": onTenant("view", lowerTenantArg),
  "Query.userInvitations": onTenant("view", lowerTenantArg),
  "Query.userGrants": onTenant("view", lowerTenantArg),
  "Mutation.inviteUser": onTenant("edit", lowerTenantArg),
  "Mutation.revokeInvitation": onTenant("edit", lowerTenantArg),
  "Mutation.updateUser": onTenant("edit", lowerTenantArg),
  "Mutation.disableUser": onTenant("edit", lowerTenantArg),
  "Mutation.enableUser": onTenant("edit", lowerTenantArg),
  "Mutation.deleteUser": onTenant("edit", lowerTenantArg),
  "Mutation.revokeUserSessions": onTenant("edit", lowerTenantArg),
  "Mutation.setUserEmailVerified": onTenant("edit", lowerTenantArg),
  "Mutation.revokeGrant": onTenant("edit", lowerTenantArg),
};

// One event per mutation, recorded once its change is stored. A repeat records
// again: the retry of a call whose record failed must not leave the change
// with no event. Targets are ids, never an address.
export const usersAudits: Audits = {
  "Mutation.inviteUser": "user.invite",
  "Mutation.revokeInvitation": "user.revokeInvitation",
  "Mutation.updateUser": "user.update",
  "Mutation.disableUser": "user.disable",
  "Mutation.enableUser": "user.enable",
  "Mutation.deleteUser": "user.delete",
  "Mutation.revokeUserSessions": "user.revokeSessions",
  "Mutation.setUserEmailVerified": "user.setEmailVerified",
  "Mutation.revokeGrant": "user.revokeGrant",
};

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
const MAX_NAME = 200;
const MAX_PREFIX = 254;
const badInput = (message: string) =>
  new GraphQLError(message, {
    extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
  });
const target = (type: string, id: string, tenantId: string) => ({
  type,
  id,
  tenantId,
});

export const users: Resolvers = {
  Query: {
    users: async (
      _,
      { tenantId: given, after, first, email, emailPrefix },
      ctx,
    ) => {
      const tenantId = tenantIdOf(given);
      const prefix = emailPrefix?.trim() ?? "";
      if (email !== null && email !== undefined && prefix !== "") {
        throw badInput("Give either email or emailPrefix, not both");
      }
      if ([...prefix].length > MAX_PREFIX) {
        throw badInput("The prefix is too long");
      }
      await activeTenant(ctx.directory, tenantId);
      if (email !== null && email !== undefined) {
        const found = await ctx.users.findByEmail(tenantId, email);
        return {
          items: found === null ? [] : [shape(found)],
          nextCursor: null,
          totalCount: found === null ? 0 : 1,
        };
      }
      const filter = prefix === "" ? {} : { emailPrefix: prefix };
      try {
        const page = await ctx.users.list(tenantId, {
          after: after ?? null,
          limit: Math.min(Math.max(first ?? 25, 1), MAX_PAGE),
          ...filter,
        });
        return {
          items: page.items.map(shape),
          nextCursor: page.nextCursor,
          totalCount: await ctx.users.count(tenantId, filter),
        };
      } catch (error) {
        if (error instanceof JanusError && error.code === "INVALID_CURSOR") {
          throw badInput("The cursor is not valid");
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
    updateUser: async (_, { tenantId: given, userId, input }, ctx) => {
      const tenantId = tenantIdOf(given);
      idArg(userId, "userId");
      const name = input.name.trim();
      if (name === "" || [...name].length > MAX_NAME) {
        throw new GraphQLError("The name must be 1 to 200 characters", {
          extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
        });
      }
      await activeTenant(ctx.directory, tenantId);
      const user = await ctx.users.rename(tenantId, userId, name);
      if (user === null) throw denial("NOT_FOUND", "No such user");
      await ctx.audit("user.update", target("user", userId, tenantId));
      return shape(user);
    },
    disableUser: (_, { tenantId, userId }, ctx) =>
      setActive(ctx, tenantId, userId, false),
    enableUser: (_, { tenantId, userId }, ctx) =>
      setActive(ctx, tenantId, userId, true),
    deleteUser: async (_, { tenantId: given, userId }, ctx) => {
      const tenantId = tenantIdOf(given);
      idArg(userId, "userId");
      const tenant = await activeTenant(ctx.directory, tenantId);
      await keepOwners(ctx, tenant, userId);
      // Alone with an `assignRole` of the same user: no assignment can be
      // written between the delete and the sweep.
      await ctx.exclusive(userKey(tenantId, userId), async () => {
        await ctx.users.delete(tenantId, userId);
        // Their role assignments go with them; on a repeat too, so a retry
        // finishes what a failed first run left.
        await rolesService.removeUser(new ObjectId(tenantId), userId);
        // An operator (a user of `clavix`) also holds console roles: they go
        // too, or a deleted account would keep its platform and tenant roles.
        if (tenant.slug === PLATFORM_TENANT_SLUG) {
          await ctx.access.removeUser(userId);
        }
      });
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
    setUserEmailVerified: async (
      _,
      { tenantId: given, userId, verified },
      ctx,
    ) => {
      const tenantId = tenantIdOf(given);
      idArg(userId, "userId");
      await activeTenant(ctx.directory, tenantId);
      const user = await ctx.users.setEmailVerified(tenantId, userId, verified);
      if (user === null) throw denial("NOT_FOUND", "No such user");
      await ctx.audit(
        "user.setEmailVerified",
        target("user", userId, tenantId),
      );
      return shape(user);
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
  const tenant = await activeTenant(ctx.directory, tenantId);
  if (!active) await keepOwners(ctx, tenant, userId);
  const user = await ctx.users.setActive(tenantId, userId, active);
  if (user === null) throw denial("NOT_FOUND", "No such user");
  await ctx.audit(
    active ? "user.enable" : "user.disable",
    target("user", userId, tenantId),
  );
  return shape(user);
}
