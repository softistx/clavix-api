import type { Resolvers } from "@/generated/console/resolvers";
import { resourceMutations } from "./resources.console-mutations";
import { resourceQueries } from "./resources.console-queries";

export { resourcesAudits, resourcesGuards } from "./resources.console-guards";

export const resources: Resolvers = {
  Query: resourceQueries,
  Mutation: resourceMutations,
};
