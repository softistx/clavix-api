import { alxia } from "@alxia/core";
import type { GraphQLContext } from "@alxia/graphql";
import { env } from "../config/env";

// The base: what every resolver reads, decorated or derived here.
export function createBase() {
  return alxia().decorate({ env });
}

export type Base = ReturnType<typeof createBase>;

// A resolver's context: Yoga's and the base's. The generated `Resolvers` takes
// it (codegen.ts: `contextType`).
export type Context = Readonly<GraphQLContext<Base>>;
