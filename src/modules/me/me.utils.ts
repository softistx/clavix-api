import { InvalidCursorError } from "@softistx/mongo";
import { ROLES, type Role } from "@/console/model";
import { fail } from "@/shared/errors";

export const MAX_PAGE = 100;

/** The page size asked, 25 by default, kept within 1 and `MAX_PAGE`. */
export const limitOf = (first: number | null | undefined) =>
  Math.min(Math.max(first ?? 25, 1), MAX_PAGE);

/** The stronger of two roles (`owner` before `admin` before `viewer`). */
export const stronger = (a: Role, b: Role | null): Role =>
  b !== null && ROLES.indexOf(b) < ROLES.indexOf(a) ? b : a;

/** A page of tenants; a cursor that is not valid is the caller's mistake. */
export async function listing<T>(page: () => Promise<T>): Promise<T> {
  try {
    return await page();
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw fail("BAD_USER_INPUT", "The cursor is not valid", { status: 400 });
    }
    throw error;
  }
}
