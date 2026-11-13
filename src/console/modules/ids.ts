import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";

/** The tenant id argument of a guarded field, lower-cased: the guard and the resolver act on the same id. */
export const lowerTenantArg = (args: Record<string, unknown>) =>
  String(args["tenantId"]).toLowerCase();

/** A tenant id as 24 lower-case hex characters, else "no such tenant". */
export function tenantIdOf(given: string) {
  if (!/^[0-9a-f]{24}$/i.test(given)) {
    throw denial("NOT_FOUND", "No such tenant");
  }
  return given.toLowerCase();
}

/** An id the trail can name (200 characters at most): refused before anything is written. */
export function idArg(given: string, name: string) {
  if (given.length === 0 || given.length > 200) {
    throw new GraphQLError(`${name} is not an id`, {
      extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
    });
  }
  return given;
}
