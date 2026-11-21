import { refusal } from "@/console/modules/refusal";
import { fail } from "@/shared/errors";
import { DomainError } from "./domains.errors";

const STATUS = {
  BAD_USER_INPUT: 400,
  NOT_FOUND: 404,
  DOMAIN_TAKEN: 409,
  DOMAIN_PRIMARY: 409,
  DOMAIN_NOT_VERIFIED: 409,
  VERIFY_COOLDOWN: 429,
} as const;

/** Runs a domains call, turning the service's refusals into the contract's GraphQL errors (the quota one too). */
export async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof DomainError) {
      throw fail(error.code, error.message, {
        status: STATUS[error.code],
        retryAfter: error.retryAfter,
        field: error.code === "BAD_USER_INPUT" ? "host" : undefined,
      });
    }
    throw refusal(error);
  }
}
