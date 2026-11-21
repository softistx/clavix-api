import { ObjectId } from "mongodb";
import { CatalogError } from "@/modules/resources";
import { RolesError } from "@/modules/roles";
import type { CliTenant } from "@/shared/cli";
import { fail } from "@/shared/errors";
import type { ConsoleContext } from "../context";
import { liveTenant, tenantIdOf } from "./ids";

const STATUS = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  DETAIL_TYPE_IN_USE: 409,
  BAD_USER_INPUT: 400,
  ROLE_MANAGED: 403,
} as const;

/** A catalog or roles refusal as a GraphQL error carrying its code. */
export const catalogError = (error: CatalogError | RolesError) =>
  fail(error.code, error.message, { status: STATUS[error.code] });

/** Runs a catalog or roles call, turning its refusals into GraphQL errors. */
export async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof CatalogError || error instanceof RolesError) {
      throw catalogError(error);
    }
    throw error;
  }
}

/**
 * The tenant the call names, as the catalog services take it (marked active:
 * only the reads and the guard-checked writes reach it, and the guard refuses
 * a suspended tenant's writes). A guard has already checked the caller's role
 * on this id; an id that names no live tenant (unknown, trashed) is "not
 * found" even for a platform operator.
 */
export async function catalogTenant(
  ctx: ConsoleContext,
  tenantId: string,
): Promise<CliTenant> {
  const found = await liveTenant(ctx.directory, tenantIdOf(tenantId));
  return { _id: new ObjectId(found.id), slug: found.slug, status: "active" };
}
