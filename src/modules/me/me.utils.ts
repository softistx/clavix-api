import { ROLES, type Role } from "@/console/model";

/** The stronger of two roles (`owner` before `admin` before `viewer`). */
export const stronger = (a: Role, b: Role | null): Role =>
  b !== null && ROLES.indexOf(b) < ROLES.indexOf(a) ? b : a;
