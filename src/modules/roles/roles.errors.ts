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
    /** The input path the refusal is about, e.g. `permissionIds.2`. */
    readonly field?: string | undefined,
  ) {
    super(message);
    this.name = "RolesError";
  }
}

export function refuse(
  code: RolesErrorCode,
  message: string,
  field?: string,
): never {
  throw new RolesError(code, message, field);
}

export const managedRefusal = (name: string) =>
  new RolesError(
    "ROLE_MANAGED",
    `The role "${name}" is managed by Clavix and cannot be changed or deleted`,
  );

export const conflict = (name: string) =>
  new RolesError("CONFLICT", `A role named "${name}" already exists here`);

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("roles", ["ROLE_MANAGED"]);
