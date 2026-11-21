import type { ErrorCode } from "@/i18n/codes";
import {
  InvalidSlugError,
  PlatformTenantProtectedError,
  SlugTakenError,
} from "@/modules/tenants";
import { QuotaExceededError } from "@/modules/usage/usage.errors";
import { fail } from "@/shared/errors";

const refuse = (
  message: string,
  code: ErrorCode,
  status: number,
  field?: string,
) => fail(code, message, { status, field });

/** A malformed input: `BAD_USER_INPUT`, 400, with the field. */
export const badInput = (message: string, field: string) =>
  refuse(message, "BAD_USER_INPUT", 400, field);

/** The service's refusals as the contract's GraphQL errors; anything else passes through. */
export function refusal(error: unknown): unknown {
  if (error instanceof SlugTakenError) {
    return refuse(error.message, "SLUG_TAKEN", 409, "slug");
  }
  if (error instanceof InvalidSlugError) return badInput(error.message, "slug");
  if (error instanceof PlatformTenantProtectedError) {
    return refuse(error.message, "PLATFORM_TENANT_PROTECTED", 409);
  }
  if (error instanceof QuotaExceededError) {
    return refuse(error.message, "QUOTA_EXCEEDED", 409, error.key);
  }
  return error;
}
