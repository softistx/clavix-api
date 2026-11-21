import { liveTenant, tenantIdOf } from "@/console/modules/ids";
import type { Resolvers } from "@/generated/console/resolvers";
import { invitationsOf } from "./admins.console-support";
import { memberOf } from "./admins.utils";

export const adminsQueries: NonNullable<Resolvers["Query"]> = {
  // The guard lower-cased the id it checked; read with the same spelling.
  memberships: async (_, { tenantId: given }, ctx) => {
    const tenantId = tenantIdOf(given);
    await liveTenant(ctx.directory, tenantId);
    return (await ctx.members.members(tenantId)).map(({ user, role }) =>
      memberOf(user, role),
    );
  },
  platformOperators: async (_, __, ctx) =>
    (await ctx.members.platformOperators()).map(({ user, role }) =>
      memberOf(user, role),
    ),
  adminInvitations: async (_, { tenantId: given }, ctx) => {
    const tenantId = tenantIdOf(given);
    await liveTenant(ctx.directory, tenantId);
    return invitationsOf(ctx, await ctx.admins.invitations(tenantId));
  },
};
