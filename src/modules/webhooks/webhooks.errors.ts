export type WebhookErrorCode = "BAD_USER_INPUT" | "NOT_FOUND";

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
