import { refusal } from "@/modules/tenants/tenants.console-errors";
import { fail } from "@/shared/errors";
import { WebhookError } from "./webhooks.errors";

const STATUS = { BAD_USER_INPUT: 400, NOT_FOUND: 404 } as const;

/** Runs a webhooks call, turning the service's refusals into the contract's GraphQL errors (the quota one too). */
export async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof WebhookError) {
      throw fail(error.code, error.message, {
        status: STATUS[error.code],
        field: error.field,
      });
    }
    throw refusal(error);
  }
}
