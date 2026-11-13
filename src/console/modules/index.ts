import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/console/resolvers";
import type { Audits } from "../audit";
import type { Guards } from "../guard";
import { me, meGuards } from "./me";

// One entry per module: its resolvers, the guard of each root field it adds
// and the audit action of each mutation it adds. A root field with no guard is
// denied (guard.ts); a mutation with no audit action fails audit.spec.ts.
export const resolvers: Resolvers = mergeResolvers([me]);
export const guards: Guards = { ...meGuards };
export const audits: Audits = {};
