import type { ValueChange, ValueInput } from "@/modules/attributes";

/** The changes of a `setMyAttributeValues` call, as the values service takes them (`null` clears). */
export const valueChangesOf = (
  values: readonly {
    attributeId: string;
    value?: ValueInput | null | undefined;
  }[],
): ValueChange[] =>
  values.map(({ attributeId, value }) => ({
    attributeId,
    value: value ?? null,
  }));

/** The janus refusals of a change token: one `EMAIL_CHANGE_INVALID`, the page offers a new request. */
export const TOKEN_REFUSALS = new Set([
  "TOKEN_UNKNOWN",
  "TOKEN_SPENT",
  "TOKEN_EXPIRED",
  "TOKEN_STALE",
  "USER_INACTIVE",
]);
