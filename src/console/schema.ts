import { basename, join } from "node:path";
import { loadFilesSync } from "@graphql-tools/load-files";
import { mergeResolvers, mergeTypeDefs } from "@graphql-tools/merge";
import type { IResolvers } from "@graphql-tools/utils";
import { createSchema, type Resolvers } from "@graxia/core";
import { scalarResolvers, scalarTypeDefs } from "@nxgt/graphql-scalars";
import { constraintTypeDefs, withValidation } from "@nxgt/graphql-validation";
import type { ConsoleContext } from "./context";
import { type Guards, guardSchema } from "./guard";
import { guards, resolvers } from "./modules";

// Every src/console/**/*.graphqls: the console API's SDL, apart from the hosted
// pages' (src/http/schema.ts leaves this folder out). Read at startup from
// src/console, beside dist/ for the bundle.
const bundled = basename(import.meta.dir) === "dist";
const sources = bundled
  ? join(import.meta.dir, "..", "src", "console")
  : import.meta.dir;

const consoleSources = [
  scalarTypeDefs,
  constraintTypeDefs,
  ...loadFilesSync(sources, { extensions: ["graphqls"] }),
];

export const consoleTypeDefs = mergeTypeDefs(consoleSources);

/**
 * The console API's schema with every root field behind its guard. Extra SDL,
 * resolvers and guards (a spec's) are added to the real ones.
 */
export function createConsoleSchema(
  extra: { typeDefs?: string; resolvers?: IResolvers; guards?: Guards } = {},
) {
  const base = createSchema<ConsoleContext>()({
    // Merged from the sources each time: merging into `consoleTypeDefs` would
    // write a spec's root types into its shared `schema { ... }` definition.
    typeDefs:
      extra.typeDefs === undefined
        ? consoleTypeDefs
        : mergeTypeDefs([...consoleSources, extra.typeDefs]),
    resolvers: mergeResolvers([
      scalarResolvers,
      resolvers,
      ...(extra.resolvers === undefined ? [] : [extra.resolvers]),
    ]) as Resolvers<ConsoleContext>,
  });
  return guardSchema(withValidation(base), { ...guards, ...extra.guards });
}

export const consoleSchema = createConsoleSchema();
