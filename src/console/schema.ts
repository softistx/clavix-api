import { basename, join } from "node:path";
import { loadFilesSync } from "@graphql-tools/load-files";
import { mergeResolvers, mergeTypeDefs } from "@graphql-tools/merge";
import type { IResolvers } from "@graphql-tools/utils";
import { scalarResolvers, scalarTypeDefs } from "@nxgt/graphql-scalars";
import { constraintTypeDefs, withValidation } from "@nxgt/graphql-validation";
import { createSchema, type Resolvers } from "@softistx/graxia";
import type { ConsoleContext } from "./context";
import { type Guards, guardSchema } from "./guard";
import { guards, resolvers } from "./modules";

// The console API's SDL: every src/console/**/*.graphqls and every module's
// `<name>.console.graphqls`, apart from the hosted pages' (src/http/schema.ts
// leaves both out). Read at startup from src/, beside dist/ for the bundle.
const bundled = basename(import.meta.dir) === "dist";
const src = bundled
  ? join(import.meta.dir, "..", "src")
  : join(import.meta.dir, "..");
const sources = [
  join(src, "console", "**", "*.graphqls"),
  join(src, "modules", "**", "*.console.graphqls"),
];

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
      // graphql-tools merges to its own resolver type; graxia's `Resolvers<Ctx>` is the same shape.
    ]) as Resolvers<ConsoleContext>,
  });
  return guardSchema(withValidation(base), { ...guards, ...extra.guards });
}

export const consoleSchema = createConsoleSchema();
