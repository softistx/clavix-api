import type { Resolvers } from "@/generated/console/resolvers";
import { userMutations } from "./mutations";
import { userQueries } from "./queries";

export { usersAudits, usersGuards } from "./guards";

export const users: Resolvers = {
  TenantUser: {
    // Read from the user's own pool, only when the field is selected.
    secondFactor: (user, _, ctx) =>
      ctx.users.secondFactor(user.tenantId, user.id),
  },
  Query: userQueries,
  Mutation: userMutations,
};
