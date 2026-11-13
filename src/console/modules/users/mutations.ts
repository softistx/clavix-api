import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import { ObjectId } from "mongodb";
import { rolesService } from "@/config/roles";
import type { Resolvers } from "@/generated/console/resolvers";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import type { ConsoleContext } from "../../context";
import { idArg, liveTenant, tenantIdOf } from "../ids";
import { userKey } from "../user-key";
import { keepOwners } from "./operators";
import { shape, target } from "./shapes";

const MAX_NAME = 200;

export const userMutations: NonNullable<Resolvers["Mutation"]> = {
  inviteUser: async (_, { tenantId: given, email }, ctx) => {
    const tenantId = tenantIdOf(given);
    const tenant = await liveTenant(ctx.directory, tenantId);
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
      throw new GraphQLError("The name must be 1 to 200 characters", {
        extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
      });
    }
    await liveTenant(ctx.directory, tenantId);
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
    const tenant = await liveTenant(ctx.directory, tenantId);
    // Alone with an `assignRole` of the same user: no assignment can be
    // written between the delete and the sweep.
    await keepOwners(ctx, tenant, tenantId, userId, () =>
      ctx.exclusive(userKey(tenantId, userId), async () => {
        await ctx.users.delete(tenantId, userId);
        // Their role assignments go with them; on a repeat too, so a retry
        // finishes what a failed first run left.
        await rolesService.removeUser(new ObjectId(tenantId), userId);
        // An operator (a user of `clavix`) also holds console roles: they go
        // too, or a deleted account would keep its platform and tenant roles.
        if (tenant.slug === PLATFORM_TENANT_SLUG) {
          await ctx.access.removeUser(userId);
        }
      }),
    );
    await ctx.audit("user.delete", target("user", userId, tenantId));
    return true;
  },
  revokeUserSessions: async (_, { tenantId: given, userId }, ctx) => {
    const tenantId = tenantIdOf(given);
    idArg(userId, "userId");
    await liveTenant(ctx.directory, tenantId);
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
    await liveTenant(ctx.directory, tenantId);
    const user = await ctx.users.setEmailVerified(tenantId, userId, verified);
    if (user === null) throw denial("NOT_FOUND", "No such user");
    await ctx.audit("user.setEmailVerified", target("user", userId, tenantId));
    return shape(user);
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
};

async function setActive(
  ctx: ConsoleContext,
  given: string,
  userId: string,
  active: boolean,
) {
  const tenantId = tenantIdOf(given);
  idArg(userId, "userId");
  const tenant = await liveTenant(ctx.directory, tenantId);
  const user = await (active
    ? ctx.users.setActive(tenantId, userId, true)
    : keepOwners(ctx, tenant, tenantId, userId, () =>
        ctx.users.setActive(tenantId, userId, false),
      ));
  if (user === null) throw denial("NOT_FOUND", "No such user");
  await ctx.audit(
    active ? "user.enable" : "user.disable",
    target("user", userId, tenantId),
  );
  return shape(user);
}
