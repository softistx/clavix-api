import type { Resolvers } from "@/generated/console/resolvers";
import { adminsMutations } from "./admins.console-mutations";
import { adminsQueries } from "./admins.console-queries";

export { adminsAudits, adminsGuards } from "./admins.console-guards";

export const admins: Resolvers = {
  Query: adminsQueries,
  Mutation: adminsMutations,
};
