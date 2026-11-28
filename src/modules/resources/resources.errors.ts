import { defineCodes } from "@/i18n/define-codes";
/** Why the catalog refused: the console maps the code to a GraphQL error. */
export type CatalogErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "BAD_USER_INPUT"
  | "DETAIL_TYPE_IN_USE"
  | "PERMISSION_IN_USE"
  | "SCOPE_IN_USE";

/** A resource or scope call the catalog refuses, with a message the console may show. */
export class CatalogError extends Error {
  override name = "CatalogError";
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
    /** The input path the refusal is about, e.g. `name`. */
    readonly field?: string | undefined,
    /** What the refusal lists: `extensions.roles` or `extensions.clients` (ids). */
    readonly extra?: Readonly<Record<string, readonly string[]>> | undefined,
  ) {
    super(message);
  }
}

/** Refuses a write with `BAD_USER_INPUT` and a message the console may show. */
export function refuse(message: string, field?: string): never {
  throw new CatalogError("BAD_USER_INPUT", message, field);
}

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("resources", [
  "DETAIL_TYPE_IN_USE",
  "PERMISSION_IN_USE",
  "SCOPE_IN_USE",
]);
