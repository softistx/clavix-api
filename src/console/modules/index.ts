import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/console/resolvers";
import type { Guards } from "../guard";
import { me, meGuards } from "./me";
import { signInMethods, signInMethodsGuards } from "./sign-in-methods";

// One entry per module: its resolvers and the guard of each root field it
// adds. A root field with no guard is denied (guard.ts).
export const resolvers: Resolvers = mergeResolvers([me, signInMethods]);
export const guards: Guards = { ...meGuards, ...signInMethodsGuards };
