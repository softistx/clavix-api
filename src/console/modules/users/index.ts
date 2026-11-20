import { freshPerMutation } from "@alxia/graphql";
import type { Resolvers } from "@/generated/console/resolvers";
import { userMutations } from "./mutations";
import { userQueries } from "./queries";
import { secondFactorLoader } from "./second-factor-loader";

export { usersAudits, usersGuards } from "./guards";

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
