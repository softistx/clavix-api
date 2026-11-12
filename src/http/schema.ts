import { basename, join } from "node:path";
import { loadFilesSync } from "@graphql-tools/load-files";
import { mergeTypeDefs } from "@graphql-tools/merge";
import { scalarResolvers, scalarTypeDefs } from "@nxgt/graphql-scalars";
import { constraintTypeDefs, withValidation } from "@nxgt/graphql-validation";
import { createSchema } from "graphql-yoga";
import { resolvers } from "../modules";
import { consentResolvers, consentTypeDefs } from "../modules/consent";
import type { Context } from "./context";

// Every src/**/*.graphqls, one per module, merged into one schema: each file
// may declare its own `type Query`. Read at startup from src/, beside dist/:
// `../..` of src/http/ under `bun dev` and `bun test`, `..` of dist/ for the
// bundle.
const bundled = basename(import.meta.dir) === "dist";
const typeDefs = mergeTypeDefs([
  scalarTypeDefs,
  constraintTypeDefs,
  consentTypeDefs,
  ...loadFilesSync(
    [
      join(import.meta.dir, bundled ? ".." : join("..", ".."), "src"),
      // The console API has its own schema (src/console/schema.ts).
      `!${join(import.meta.dir, bundled ? ".." : join("..", ".."), "src", "console")}/**`,
    ],
    { extensions: ["graphqls"] },
  ),
]);

export const schema = withValidation(
  createSchema<Context>({
    typeDefs,
    resolvers: [scalarResolvers, resolvers, consentResolvers],
  }),
);
