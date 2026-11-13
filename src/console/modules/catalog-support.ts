import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import { ObjectId } from "mongodb";
import type { CliTenant } from "@/cli/errors";
import { CatalogError } from "@/modules/resources/catalog.errors";
import type { ConsoleContext } from "../context";

const STATUS = { NOT_FOUND: 404, CONFLICT: 409, BAD_USER_INPUT: 400 } as const;

/** A catalog refusal as a GraphQL error carrying its code. */
export const catalogError = (error: CatalogError) =>
  new GraphQLError(error.message, {
    extensions: { code: error.code, http: { status: STATUS[error.code] } },
  });

/** Runs a catalog call, turning its refusals into GraphQL errors. */
export async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof CatalogError) throw catalogError(error);
    throw error;
  }
}

/**
 * The active tenant the call names. A guard has already checked the caller's
 * role on this id; an id that names no live tenant (unknown, suspended) is
 * "not found" even for a platform operator.
 */
export async function activeTenant(
  ctx: ConsoleContext,
  tenantId: string,
): Promise<CliTenant> {
  if (!ObjectId.isValid(tenantId)) throw denial("NOT_FOUND", "No such tenant");
  const [found] = await ctx.directory.tenantsByIds([tenantId]);
  if (found === undefined) throw denial("NOT_FOUND", "No such tenant");
  return { _id: new ObjectId(found.id), slug: found.slug, status: "active" };
}

/** The tenant id argument of a guarded field. */
export const tenantArg = (args: Record<string, unknown>) =>
  String(args["tenantId"]);
