import { basename, join } from "node:path";
import { loadFilesSync } from "@graphql-tools/load-files";
import { mergeTypeDefs } from "@graphql-tools/merge";
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
  extra: {
    typeDefs?: string;
    resolvers?: Resolvers<ConsoleContext>;
    guards?: Guards;
  } = {},
) {
  const base = createSchema<ConsoleContext>()({
    // Merged from the sources each time: merging into `consoleTypeDefs` would
    // write a spec's root types into its shared `schema { ... }` definition.
    typeDefs:
      extra.typeDefs === undefined
        ? consoleTypeDefs
        : mergeTypeDefs([...consoleSources, extra.typeDefs]),
    // graxia merges the maps per type and field itself.
    resolvers: [
      scalarResolvers,
      resolvers,
      ...(extra.resolvers === undefined ? [] : [extra.resolvers]),
    ],
  });
  return guardSchema(withValidation(base), { ...guards, ...extra.guards });
}

export const consoleSchema = createConsoleSchema();
