export type RolesErrorCode = "NOT_FOUND" | "CONFLICT" | "BAD_USER_INPUT";

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
