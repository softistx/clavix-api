import type { GraphQLResolveInfo } from "graphql";
import {
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  OperationTypeNode,
} from "graphql";
import type { Resolver } from "@/generated/graphql/resolvers";
import { defined } from "~/narrow";

const parentType = new GraphQLObjectType({
  name: "Mutation",
  fields: { noop: { type: GraphQLString } },
});

/** A complete resolve info, for a spec that calls a resolver without executing a document. */
export const resolveInfo: GraphQLResolveInfo = {
  fieldName: "noop",
  fieldNodes: [],
  returnType: GraphQLString,
  parentType,
  path: { prev: undefined, key: "noop", typename: "Mutation" },
  schema: new GraphQLSchema({ mutation: parentType }),
  fragments: {},
  rootValue: null,
  operation: {
    kind: Kind.OPERATION_DEFINITION,
    operation: OperationTypeNode.MUTATION,
    selectionSet: { kind: Kind.SELECTION_SET, selections: [] },
  },
  variableValues: { sources: {}, coerced: {} },
  getAbortSignal: () => undefined,
  getAsyncHelpers: () => ({
    promiseAll: (values) => Promise.all(values),
    track: () => {},
  }),
};

/** Runs a generated resolver, the function or the `{ resolve }` form, with the given parent, arguments and context. */
export async function callResolver<R, P, C, A>(
  resolver: Resolver<R, P, C, A> | undefined,
  parent: P,
  args: A,
  ctx: C,
): Promise<R> {
  const found = defined(resolver, "the resolver");
  const fn = typeof found === "function" ? found : found.resolve;
  return fn(parent, args, ctx, resolveInfo);
}
