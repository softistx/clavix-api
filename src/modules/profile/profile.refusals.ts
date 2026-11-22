import { fail } from "@/shared/errors";
import type { codes } from "./profile.errors";

/** The HTTP status of each code of this module (the plan's table). */
const STATUS = {
  PROFILE_FIELD_INVALID: 400,
  PROFILE_FIELD_LOCKED: 403,
} as const satisfies Record<(typeof codes.codes)[number], number>;

/** A refusal of this module: one of its codes, its message and the field it is about. */
export function refuse(
  code: (typeof codes.codes)[number],
  message: string,
  field?: string,
): never {
  throw fail(code, message, { status: STATUS[code], field });
}

export { refuseCommon } from "@/shared/errors";
