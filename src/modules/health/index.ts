import type { Resolvers } from "@/generated/graphql/resolvers";
import pkg from "../../../package.json" with { type: "json" };

export const version: string = pkg.version;

export const health: Resolvers = {
  Query: {
    health: () => ({ status: "ok", version }),
  },
};
