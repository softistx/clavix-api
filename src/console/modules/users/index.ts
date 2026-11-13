import type { Resolvers } from "@/generated/console/resolvers";
import { userMutations } from "./mutations";
import { userQueries } from "./queries";

export { usersAudits, usersGuards } from "./guards";

export const users: Resolvers = {
  Query: userQueries,
  Mutation: userMutations,
};
