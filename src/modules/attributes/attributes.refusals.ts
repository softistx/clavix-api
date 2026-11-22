import type { ErrorCode } from "@/i18n/codes";
import { fail } from "@/shared/errors";
import type { codes } from "./attributes.errors";

/** The HTTP status of each code of this module (the plan's table). */
const STATUS = {
  ATTRIBUTE_KEY_INVALID: 400,
  ATTRIBUTE_KEY_RESERVED: 400,
  ATTRIBUTE_KEY_TAKEN: 409,
  ATTRIBUTE_LIMIT: 409,
  ATTRIBUTE_TYPE_LOCKED: 409,
  ATTRIBUTE_UNIQUE_UNSUPPORTED: 400,
  ATTRIBUTE_NOT_UNIQUE: 409,
  ATTRIBUTE_EDITABLE_EMITTED: 400,
  ATTRIBUTE_SCOPE_UNKNOWN: 400,
  ATTRIBUTE_OPTION_IN_USE: 409,
  ATTRIBUTE_ARCHIVED: 409,
  ATTRIBUTE_NOT_ARCHIVED: 409,
  ATTRIBUTE_DELETE_UNCONFIRMED: 400,
} as const satisfies Record<(typeof codes.codes)[number], number>;

/** A refusal of this module: one of its codes, its message and the field it is about. */
export function refuse(
  code: (typeof codes.codes)[number],
  message: string,
  field?: string,
): never {
  throw fail(code, message, { status: STATUS[code], field });
}

/** A refusal with a common code (`NOT_FOUND`, `CONFLICT`, `BAD_USER_INPUT`) and its status. */
export function refuseCommon(
  code: Extract<ErrorCode, "NOT_FOUND" | "CONFLICT" | "BAD_USER_INPUT">,
  message: string,
  field?: string,
): never {
  const status = { NOT_FOUND: 404, CONFLICT: 409, BAD_USER_INPUT: 400 }[code];
  throw fail(code, message, { status, field });
}
