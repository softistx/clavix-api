/** Why the catalog refused: the console maps the code to a GraphQL error. */
export type CatalogErrorCode = "NOT_FOUND" | "CONFLICT" | "BAD_USER_INPUT";

/** A resource or scope call the catalog refuses, with a message the console may show. */
export class CatalogError extends Error {
  override name = "CatalogError";
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
  ) {
    super(message);
  }
}
