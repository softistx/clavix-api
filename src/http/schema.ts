import { basename, join } from "node:path";
import { loadFilesSync } from "@graphql-tools/load-files";
import { mergeResolvers, mergeTypeDefs } from "@graphql-tools/merge";
import { createSchema, type Resolvers } from "@graxia/core";
import { scalarResolvers, scalarTypeDefs } from "@nxgt/graphql-scalars";
import { constraintTypeDefs, withValidation } from "@nxgt/graphql-validation";
import { resolvers } from "../modules";
import { guardedSchema } from "../modules/auth/plugin";
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

export const schema = guardedSchema(
  withValidation(
    createSchema<Context>()({
      typeDefs,
      // graxia takes graphql-tools' merged map: its element types differ from graxia's own.
      resolvers: mergeResolvers([
        scalarResolvers,
        resolvers,
        consentResolvers,
      ]) as Resolvers<Context>,
    }),
  ),
);
