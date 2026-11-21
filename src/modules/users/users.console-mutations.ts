import { denial } from "@softistx/janus-graphql";
import { ObjectId } from "mongodb";
import { rolesService } from "@/config/roles";
import { idArg, liveTenant, tenantIdOf } from "@/console/modules/ids";
import { userKey } from "@/console/modules/user-key";
import type { Resolvers } from "@/generated/console/resolvers";
import { refusing } from "@/modules/admins/admins.errors";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { fail } from "@/shared/errors";
import { setActive } from "./users.console-support";
import { keepOwners } from "./users.owners";
import { shape, target } from "./users.utils";

const MAX_NAME = 200;

export const userMutations: NonNullable<Resolvers["Mutation"]> = {
  inviteUser: async (_, { tenantId: given, email }, ctx) => {
    const tenantId = tenantIdOf(given);
    const tenant = await liveTenant(ctx.directory, tenantId);
    if ((await ctx.users.findByEmail(tenantId, email)) !== null) {
      throw fail("USER_EXISTS", "This address already has an account", {
        status: 409,
      });
    }
    await ctx.budgets?.invitation({ tenantId });
    const inviter = await ctx.directory.findUser(ctx.principal.userId);
    const invitation = await refusing(() =>
      ctx.users.invite({
        tenantId,
        tenantName: tenant.name,
        email,
        invitedBy: {
          id: ctx.principal.userId,
          name: inviter?.name ?? inviter?.email,
        },
      }),
    );
    await ctx.audit(
      "user.invite",
      target("invitation", invitation.id, tenantId),
    );
    return invitation;
  },
  revokeInvitation: async (_, { tenantId: given, invitationId }, ctx) => {
    const tenantId = tenantIdOf(given);
    idArg(invitationId, "invitationId");
    await liveTenant(ctx.directory, tenantId);
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
      throw fail("BAD_USER_INPUT", "The name must be 1 to 200 characters", {
        status: 400,
      });
    }
    await liveTenant(ctx.directory, tenantId);
    const user = await ctx.users.rename(tenantId, userId, name);
    if (user === null) throw denial("NOT_FOUND", "No such user");
    await ctx.audit("user.update", target("user", userId, tenantId));
    return shape(user, tenantId);
  },
  disableUser: (_, { tenantId, userId }, ctx) =>
    setActive(ctx, tenantId, userId, false),
  enableUser: (_, { tenantId, userId }, ctx) =>
    setActive(ctx, tenantId, userId, true),
  deleteUser: async (_, { tenantId: given, userId }, ctx) => {
    const tenantId = tenantIdOf(given);
    idArg(userId, "userId");
    const tenant = await liveTenant(ctx.directory, tenantId);
    // Alone with an `assignRole` of the same user: no assignment can be
    // written between the delete and the sweep.
    await keepOwners(
      ctx,
      tenant,
      userId,
      async () => {
        await ctx.users.delete(tenantId, userId);
        // Their role assignments go with them; on a repeat too, so a retry
        // finishes what a failed first run left.
        await rolesService.removeUser(new ObjectId(tenantId), userId);
        // An operator (a user of `clavix`) also holds console roles: they go
        // too, or a deleted account would keep its platform and tenant roles.
        if (tenant.slug === PLATFORM_TENANT_SLUG) {
          await ctx.access.removeUser(userId);
        }
      },
      "delete",
      userKey(tenantId, userId),
    );
    await ctx.audit("user.delete", target("user", userId, tenantId));
    return true;
  },
  revokeUserSessions: async (_, { tenantId: given, userId }, ctx) => {
    const tenantId = tenantIdOf(given);
    idArg(userId, "userId");
    const tenant = await liveTenant(ctx.directory, tenantId);
    const ended = await keepOwners(
      ctx,
      tenant,
      userId,
      () => ctx.users.revokeSessions(tenantId, userId),
      "touch",
      userKey(tenantId, userId),
    );
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
    const tenant = await liveTenant(ctx.directory, tenantId);
    // Un-verifying locks the account out of the console (ADR-0041): an
    // owner's is the owners' business, and the last one keeps theirs.
    const user = await keepOwners(
      ctx,
      tenant,
      userId,
      () => ctx.users.setEmailVerified(tenantId, userId, verified),
      verified ? "touch" : "unverify",
      userKey(tenantId, userId),
    );
    if (user === null) throw denial("NOT_FOUND", "No such user");
    await ctx.audit("user.setEmailVerified", target("user", userId, tenantId));
    return shape(user, tenantId);
  },
  resetUserSecondFactor: async (_, { tenantId: given, userId }, ctx) => {
    const tenantId = tenantIdOf(given);
    idArg(userId, "userId");
    const tenant = await liveTenant(ctx.directory, tenantId);
    const user = await keepOwners(
      ctx,
      tenant,
      userId,
      () => ctx.users.resetSecondFactor(tenantId, userId),
      "touch",
      userKey(tenantId, userId),
    );
    if (user === null) throw denial("NOT_FOUND", "No such user");
    await ctx.audit("user.resetSecondFactor", target("user", userId, tenantId));
    return shape(user, tenantId);
  },
  revokeGrant: async (_, { tenantId: given, userId, grantId }, ctx) => {
    const tenantId = tenantIdOf(given);
    idArg(userId, "userId");
    idArg(grantId, "grantId");
    await liveTenant(ctx.directory, tenantId);
    const revoked = await ctx.users.revokeGrant(tenantId, userId, grantId);
    // Recorded on a repeat and on a grant that is not this user's too:
    // the id is only named, never read.
    await ctx.audit("user.revokeGrant", target("grant", grantId, tenantId));
    return revoked;
  },
  revokeUserSession: async (_, { tenantId: given, userId, sessionId }, ctx) => {
    const tenantId = tenantIdOf(given);
    idArg(userId, "userId");
    idArg(sessionId, "sessionId");
    await liveTenant(ctx.directory, tenantId);
    const ended = await ctx.users.revokeSession(tenantId, userId, sessionId);
    // Recorded on a repeat and on a session that is not this user's too:
    // the id is only named, never read.
    await ctx.audit(
      "user.revokeSession",
      target("session", sessionId, tenantId),
    );
    return ended;
  },
};
