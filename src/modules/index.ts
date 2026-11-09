import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/graphql/resolvers";
import { health } from "./health";

// One entry per module; each module exports its `Resolvers`.
export const resolvers: Resolvers = mergeResolvers([health]);
