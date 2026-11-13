import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/console/resolvers";
import type { Guards } from "../guard";
import { clients, clientsGuards } from "./clients";
import { me, meGuards } from "./me";
import { resources, resourcesGuards } from "./resources";

// One entry per module: its resolvers and the guard of each root field it
// adds. A root field with no guard is denied (guard.ts).
export const resolvers: Resolvers = mergeResolvers([me, clients, resources]);
export const guards: Guards = {
  ...meGuards,
  ...clientsGuards,
  ...resourcesGuards,
};
