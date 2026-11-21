import { basename, join } from "node:path";
import { loadFilesSync } from "@graphql-tools/load-files";
import { mergeResolvers, mergeTypeDefs } from "@graphql-tools/merge";
import { scalarResolvers, scalarTypeDefs } from "@nxgt/graphql-scalars";
import { constraintTypeDefs, withValidation } from "@nxgt/graphql-validation";
import { createSchema, type Resolvers } from "@softistx/graxia";
import { resolvers } from "../modules";
import { guardedSchema } from "../modules/auth/auth.plugin";
import {
  consentResolvers,
  consentTypeDefs,
} from "../modules/consent/consent.resolver";
import type { Context } from "./context";

// Every src/**/*.graphqls, one per module, merged into one schema: each file
// may declare its own `type Query`. Read at startup from src/, beside dist/:
// `../..` of src/http/ under `bun dev` and `bun test`, `..` of dist/ for the
// bundle.
const bundled = basename(import.meta.dir) === "dist";
const src = join(import.meta.dir, bundled ? ".." : join("..", ".."), "src");

/**
 * The hosted SDL: every src/**\/*.graphqls but the console's. Every pattern is
 * built from `src`, never relative, since a relative negation resolves against
 * process.cwd() and a server started elsewhere would load the console roots.
 */
export const hostedTypeDefs = () =>
  mergeTypeDefs([
    scalarTypeDefs,
    constraintTypeDefs,
    consentTypeDefs,
    ...loadFilesSync(
      [
        src,
        // The console API has its own schema (src/console/schema.ts): its
        // folder and every module's `<name>.console.graphqls`.
        `!${join(src, "console")}/**`,
        `!${join(src, "**", "*.console.graphqls")}`,
      ],
      // No ignored extensions: the default `d` one drops every file named
      // `<module>.d….graphqls` (consent.detail-labels.graphqls) from a folder
      // pattern. There are no `.spec` or `.test` SDL files to skip.
      { extensions: ["graphqls"], ignoredExtensions: [] },
    ),
  ]);

const typeDefs = hostedTypeDefs();

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
