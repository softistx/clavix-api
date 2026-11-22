import { graphql } from "@softistx/alxia-graphql";
import { useWithoutQuotedValues } from "@/http/coercion";
import type { Base } from "@/http/context";
import { useClientHeader } from "@/http/csrf";
import { reportUnexpected } from "@/http/unexpected";
import { janusMasking } from "@/modules/auth/auth.plugin";
import { useInviteBudget } from "./budgets";
import { CONSOLE_PATH } from "./identity";
import { type ConsoleDeps, useConsole } from "./plugin";
import { consoleSchema } from "./schema";

/** The highest cost of a console operation (graxia `limits.cost.max`; its default is 5 000). */
const CONSOLE_MAX_COST = 50_000;

/** The console's deps and the schema to serve (the console's own by default). */
export type ConsoleGraphqlOptions = ConsoleDeps & {
  schema?: typeof consoleSchema;
};

/** Mounts the console API at `CONSOLE_PATH`: bearer token, its own schema (`./schema`). */
export function mountConsoleGraphql(
  app: Base,
  options: ConsoleGraphqlOptions,
  requireClient: boolean,
) {
  return graphql(app, {
    schema: options.schema ?? consoleSchema,
    path: CONSOLE_PATH,
    ide: false,
    // Deliberate: the bearer token is checked first (`useConsole`), so only an authenticated admin introspects.
    introspection: true,
    // The console reads a tenant's stored lists nested (resources > detail types > fields >
    // values): ten items assumed per list put the UI's Applications read at 24 530, over
    // graxia's default 5 000, refused with HTTP 200 and no data. The caller is an
    // authenticated, verified admin, and the limit still refuses a read that multiplies
    // those lists (aliases). Spec: `modules/resources/resources.cost.console.spec.ts`.
    limits: { cost: { max: CONSOLE_MAX_COST } },
    onUnexpected: reportUnexpected,
    plugins: [
      useClientHeader(requireClient),
      // Second, after the client header: aliased invitations are counted before anything runs.
      useInviteBudget(options.budgets.inviteCaller),
      useWithoutQuotedValues(),
      useConsole(options),
    ],
    ...janusMasking,
  });
}
