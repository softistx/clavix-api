import { refusal } from "@/console/modules/refusal";
import { fail } from "@/shared/errors";
import { ConnectionError } from "./connections.errors";

const STATUS = {
  BAD_USER_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONNECTION_IN_USE: 409,
  DOMAIN_TAKEN: 409,
  DOMAIN_NOT_VERIFIED: 409,
  VERIFY_COOLDOWN: 429,
  ISSUER_REFUSED: 400,
  ISSUER_UNREACHABLE: 502,
} as const;

/** Runs a connections call, turning the service's refusals into the contract's GraphQL errors (the quota one too). */
export async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ConnectionError) {
      throw fail(error.code, error.message, {
        status: STATUS[error.code],
        field: error.field,
        retryAfter: error.retryAfter,
      });
    }
    throw refusal(error);
  }
}
