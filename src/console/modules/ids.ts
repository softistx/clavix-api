import { denial } from "@softistx/janus-graphql";
import { fail } from "@/shared/errors";
import type { ConsoleDirectory } from "../context";

/** The tenant id argument of a guarded field, lower-cased: the guard and the resolver act on the same id. */
export const tenantArg = (args: Record<string, unknown>) =>
  String(args["tenantId"]).toLowerCase();

/** A tenant id as 24 lower-case hex characters, else "no such tenant". */
export function tenantIdOf(given: string) {
  if (!/^[0-9a-f]{24}$/i.test(given)) {
    throw denial("NOT_FOUND", "No such tenant");
  }
  return given.toLowerCase();
}

/**
 * The tenant when it exists and is not in the trash, else a 404. A suspended
 * tenant is returned (ADR-0039: its console stays readable; the guard refuses
 * its writes). `id` is the form `tenantIdOf` returns.
 */
export async function liveTenant(directory: ConsoleDirectory, id: string) {
  const [tenant] = await directory.tenantsByIds([id]);
  if (tenant === undefined) throw denial("NOT_FOUND", "No such tenant");
  return tenant;
}

/** An id the trail can name (200 characters at most): refused before anything is written. */
export function idArg(given: string, name: string) {
  if (given.length === 0 || given.length > 200) {
    throw fail("BAD_USER_INPUT", `${name} is not an id`, { status: 400 });
  }
  return given;
}
