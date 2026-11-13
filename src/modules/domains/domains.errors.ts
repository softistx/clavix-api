/** A refusal of the domains service; the console maps `code` to `extensions.code`. */
export type DomainErrorCode =
  | "BAD_USER_INPUT"
  | "NOT_FOUND"
  | "DOMAIN_TAKEN"
  | "DOMAIN_PRIMARY"
  | "DOMAIN_NOT_VERIFIED";

export class DomainError extends Error {
  override name = "DomainError";
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
  }
}
