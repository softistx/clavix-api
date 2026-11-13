import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/console/resolvers";
import type { Guards } from "../guard";
import { branding, brandingGuards } from "./branding";
import { me, meGuards } from "./me";
import { signInMethods, signInMethodsGuards } from "./sign-in-methods";

// One entry per module: its resolvers and the guard of each root field it
// adds. A root field with no guard is denied (guard.ts).
export const resolvers: Resolvers = mergeResolvers([
  me,
  branding,
  signInMethods,
]);
export const guards: Guards = {
  ...meGuards,
  ...brandingGuards,
  ...signInMethodsGuards,
};
