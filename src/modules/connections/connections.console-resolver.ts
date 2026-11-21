import type { Resolvers } from "@/generated/console/resolvers";
import { connectionMutations } from "./connections.console-mutations";
import { connectionQueries } from "./connections.console-queries";

export {
  connectionsAudits,
  connectionsGuards,
} from "./connections.console-guards";

export const connections: Resolvers = {
  Query: connectionQueries,
  Mutation: connectionMutations,
};
