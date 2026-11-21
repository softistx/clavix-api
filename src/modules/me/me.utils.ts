import { ROLES, type Role } from "@/console/model";

export const MAX_PAGE = 100;

/** The page size asked, 25 by default, kept within 1 and `MAX_PAGE`. */
export const limitOf = (first: number | null | undefined) =>
  Math.min(Math.max(first ?? 25, 1), MAX_PAGE);

/** The stronger of two roles (`owner` before `admin` before `viewer`). */
export const stronger = (a: Role, b: Role | null): Role =>
  b !== null && ROLES.indexOf(b) < ROLES.indexOf(a) ? b : a;
