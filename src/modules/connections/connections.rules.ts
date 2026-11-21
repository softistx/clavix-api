import { ConnectionError } from "./connections.errors";

/** The domains one connection may hold. */
export const MAX_DOMAINS = 20;

/** A connection's display name: trimmed, 1 to 100 characters. */
export function nameOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 100) {
    throw new ConnectionError(
      "BAD_USER_INPUT",
      "The name is 1 to 100 characters",
      "name",
    );
  }
  return trimmed;
}
