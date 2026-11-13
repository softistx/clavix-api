import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/console/resolvers";
import type { Audits } from "../audit";
import type { Guards } from "../guard";
import { branding, brandingAudits, brandingGuards } from "./branding";
import { me, meGuards } from "./me";
import {
  signInMethods,
  signInMethodsAudits,
  signInMethodsGuards,
} from "./sign-in-methods";

// One entry per module: its resolvers, the guard of each root field it adds
// and the audit action of each mutation it adds. A root field with no guard is
// denied (guard.ts); a mutation with no audit action fails audit.spec.ts.
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
export const audits: Audits = { ...brandingAudits, ...signInMethodsAudits };
