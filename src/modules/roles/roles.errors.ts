import { defineCodes } from "@/i18n/define-codes";
export type RolesErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "BAD_USER_INPUT"
  | "ROLE_MANAGED";

/** A refusal the console maps to `extensions.code`. */
export class RolesError extends Error {
  constructor(
    readonly code: RolesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RolesError";
  }
}

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("roles", ["ROLE_MANAGED"]);
