import type { ErrorCode } from "@/i18n/codes";
import { defineCodes } from "@/i18n/define-codes";
import { fail } from "@/shared/errors";

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("attributes", [
  "ATTRIBUTE_KEY_INVALID",
  "ATTRIBUTE_KEY_RESERVED",
  "ATTRIBUTE_KEY_TAKEN",
  "ATTRIBUTE_LIMIT",
  "ATTRIBUTE_TYPE_LOCKED",
  "ATTRIBUTE_UNIQUE_UNSUPPORTED",
  "ATTRIBUTE_NOT_UNIQUE",
  "ATTRIBUTE_EDITABLE_EMITTED",
  "ATTRIBUTE_SCOPE_UNKNOWN",
  "ATTRIBUTE_OPTION_IN_USE",
  "ATTRIBUTE_ARCHIVED",
  "ATTRIBUTE_NOT_ARCHIVED",
  "ATTRIBUTE_DELETE_UNCONFIRMED",
]);

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
