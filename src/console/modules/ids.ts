import { badInput, fail } from "@/shared/errors";
import type { ConsoleDirectory } from "../context";

/** The tenant id argument of a guarded field, lower-cased: the guard and the resolver act on the same id. */
export const tenantArg = (args: Record<string, unknown>) =>
  String(args["tenantId"]).toLowerCase();

/** A tenant id as 24 lower-case hex characters, else "no such tenant". */
export function tenantIdOf(given: string) {
  if (!/^[0-9a-f]{24}$/i.test(given)) {
    throw fail("NOT_FOUND", "No such tenant", { status: 404 });
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
  if (tenant === undefined)
    throw fail("NOT_FOUND", "No such tenant", { status: 404 });
  return tenant;
}

/** An id the trail can name (200 characters at most): refused before anything is written. */
export function idArg(given: string, name: string) {
  if (given.length === 0 || given.length > 200) {
    throw badInput(`${name} is not an id`);
  }
  return given;
}

const MAX_PAGE = 100;

/**
 * The page size a call asked for, kept within 1 and `max`: 25 by default and
 * 100 at most. A list with its own bounds (a typeahead, the attempts an
 * endpoint keeps) passes them.
 */
export const pageSize = (
  first: number | null | undefined,
  fallback = 25,
  max = MAX_PAGE,
) => Math.min(Math.max(first ?? fallback, 1), max);
