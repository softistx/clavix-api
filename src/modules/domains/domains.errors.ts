import { defineCodes } from "@/i18n/define-codes";

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

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("domains", [
  "DOMAIN_TAKEN",
  "DOMAIN_PRIMARY",
  "DOMAIN_NOT_VERIFIED",
  "VERIFY_COOLDOWN",
]);

export const domainNotFound = () =>
  new DomainError("NOT_FOUND", "No such domain");

export const domainTaken = () =>
  new DomainError(
    "DOMAIN_TAKEN",
    "This domain is already verified by another tenant",
  );

export const domainNotVerified = () =>
  new DomainError(
    "DOMAIN_NOT_VERIFIED",
    "Only a verified domain can be made primary",
  );

export const domainIsPrimary = () =>
  new DomainError(
    "DOMAIN_PRIMARY",
    "Make another domain primary before removing this one",
  );

/** A claim checked `retryAfter` seconds too recently (`VERIFY_COOLDOWN`). */
export const verifyCooldown = (retryAfter: number) =>
  new DomainError(
    "VERIFY_COOLDOWN",
    "This domain was checked a moment ago; try again shortly",
    retryAfter,
  );

export const badDomainInput = (message: string) =>
  new DomainError("BAD_USER_INPUT", message);

/** A host the console refuses to claim, and why (the message is shown to the owner). */
export class DomainHostError extends Error {
  override name = "DomainHostError";
}
