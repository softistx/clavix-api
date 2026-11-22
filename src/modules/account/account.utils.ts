import type { ValueChange, ValueInput } from "@/modules/attributes";
import { badInput } from "@/shared/errors";

export const MAX_NAME = 200;

/** A display name of 1 to 200 characters once trimmed. */
export function cleanName(raw: string): string {
  const name = raw.trim();
  if (name === "" || [...name].length > MAX_NAME) {
    throw badInput("The name must be 1 to 200 characters", "name");
  }
  return name;
}

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
