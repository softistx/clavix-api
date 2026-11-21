import type { Resolvers } from "@/generated/graphql/resolvers";

import { version } from "./health.version";

export const health: Resolvers = {
  Query: {
    health: () => ({ status: "ok", version }),
  },
};
