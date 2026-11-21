import { refuse } from "./roles.errors";

const NAME = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_DESCRIPTION = 300;
export const MAX_ID = 200;

/** The trimmed role name; `BAD_USER_INPUT` when it is not 1 to 64 safe characters. */
export function cleanName(name: string): string {
  const clean = name.trim();
  if (!NAME.test(clean)) {
    refuse(
      "BAD_USER_INPUT",
      "a role name is 1 to 64 characters of letters, digits, '.', '_', ':' and '-'",
    );
  }
  return clean;
}

/** The trimmed description (empty when none); `BAD_USER_INPUT` past 300 characters. */
export function cleanDescription(text: string | undefined): string {
  const clean = (text ?? "").trim();
  if (clean.length > MAX_DESCRIPTION) {
    refuse(
      "BAD_USER_INPUT",
      `a description has at most ${MAX_DESCRIPTION} characters`,
    );
  }
  return clean;
}

/** A janus user id is a non-empty string of at most 200 characters. */
export function checkUserId(userId: string): void {
  if (userId.length === 0 || userId.length > MAX_ID) {
    refuse("BAD_USER_INPUT", "userId is not an id");
  }
}
