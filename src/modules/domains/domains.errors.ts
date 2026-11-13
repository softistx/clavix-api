/** A refusal of the domains service; the console maps `code` to `extensions.code`. */
export type DomainErrorCode =
  | "BAD_USER_INPUT"
  | "NOT_FOUND"
  | "DOMAIN_TAKEN"
  | "DOMAIN_PRIMARY"
  | "DOMAIN_NOT_VERIFIED"
  | "VERIFY_COOLDOWN";

export class DomainError extends Error {
  override name = "DomainError";
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    /** `VERIFY_COOLDOWN` only: the seconds until the claim may be checked again. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}
