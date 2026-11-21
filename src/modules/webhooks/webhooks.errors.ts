import type { ErrorCode } from "@/i18n/codes";

/** The codes the endpoints service raises: two of the inventory (its status table covers these only). */
export type WebhookErrorCode = Extract<
  ErrorCode,
  "BAD_USER_INPUT" | "NOT_FOUND"
>;

/** A refusal of the endpoints service; the console turns it into a GraphQL error. */
export class WebhookError extends Error {
  override name = "WebhookError";
  constructor(
    readonly code: WebhookErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** Why an endpoint URL is refused: a code for the console, a message for a person. */
export class WebhookUrlError extends Error {
  override name = "WebhookUrlError";
  constructor(
    readonly code: "invalid" | "notHttps" | "credentials" | "notPublic",
    message: string,
  ) {
    super(message);
  }
}
