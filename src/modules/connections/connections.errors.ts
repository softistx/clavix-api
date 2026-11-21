import { defineCodes } from "@/i18n/define-codes";
export type ConnectionErrorCode =
  | "BAD_USER_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CONNECTION_IN_USE"
  | "DOMAIN_TAKEN"
  | "DOMAIN_NOT_VERIFIED"
  | "VERIFY_COOLDOWN"
  | "ISSUER_REFUSED"
  | "ISSUER_UNREACHABLE";

/** A refusal of the connections service; the console maps `code` to `extensions.code`. */
export class ConnectionError extends Error {
  override name = "ConnectionError";
  constructor(
    readonly code: ConnectionErrorCode,
    message: string,
    readonly field?: string,
    /** `VERIFY_COOLDOWN` only: the seconds until the domain may be checked again. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("connections", [
  "CONNECTION_IN_USE",
  "ISSUER_REFUSED",
  "ISSUER_UNREACHABLE",
  "SSO_REQUIRED",
]);
