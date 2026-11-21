import { freshPerMutation } from "@softistx/alxia-graphql";
import type { Resolvers } from "@/generated/console/resolvers";
import { userMutations } from "./users.console-mutations";
import { userQueries } from "./users.console-queries";
import { secondFactorLoader } from "./users.data-loader";

export { usersAudits, usersGuards } from "./users.console-guards";

export const users: Resolvers = freshPerMutation({
  TenantUser: {
    // Read from the user's own pool, only when the field is selected, and
    // batched for a page of users.
    secondFactor: (user, _, ctx) =>
      secondFactorLoader(ctx, user.tenantId).load(user.id),
  },
  Query: userQueries,
  Mutation: userMutations,
});
