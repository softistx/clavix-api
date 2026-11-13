import { GraphQLError } from "graphql";
import {
  InvalidSlugError,
  PlatformTenantProtectedError,
  SlugTakenError,
} from "@/modules/tenants/tenants.errors";
import { QuotaExceededError } from "@/modules/usage/quota";

const fail = (message: string, code: string, status: number, field?: string) =>
  new GraphQLError(message, {
    extensions: {
      code,
      http: { status },
      ...(field === undefined ? {} : { field }),
    },
  });

/** A malformed input: `BAD_USER_INPUT`, 400, with the field. */
export const badInput = (message: string, field: string) =>
  fail(message, "BAD_USER_INPUT", 400, field);

/** The service's refusals as the contract's GraphQL errors; anything else passes through. */
export function refusal(error: unknown): unknown {
  if (error instanceof SlugTakenError) {
    return fail(error.message, "SLUG_TAKEN", 409, "slug");
  }
  if (error instanceof InvalidSlugError) return badInput(error.message, "slug");
  if (error instanceof PlatformTenantProtectedError) {
    return fail(error.message, "PLATFORM_TENANT_PROTECTED", 409);
  }
  if (error instanceof QuotaExceededError) {
    return fail(error.message, "QUOTA_EXCEEDED", 409, error.key);
  }
  return error;
}
