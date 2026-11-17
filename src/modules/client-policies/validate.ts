import { CatalogError } from "@/modules/resources/catalog.errors";

const MAX_TARGETS = 20;
const MAX_SUBJECT_CLIENTS = 50;
const SUBJECT_ID = /^[a-z0-9-]{1,64}$/;

/**
 * The token exchange rules a call asks for, checked and deduplicated: each
 * target is one of the tenant's resources (`resourceUris`) and the subject
 * clients are `"any"` or a list of client ids (checked for shape only: a
 * client may be created later). Throws `BAD_USER_INPUT`.
 */
export function validateTokenExchange(
  input: {
    targetResources: readonly string[];
    subjectClients: readonly string[] | "any";
  },
  resourceUris: readonly string[],
): { targets: string[]; subjects: string[] | "any" } {
  const targets = [...new Set(input.targetResources)];
  if (targets.length > MAX_TARGETS) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      `a client exchanges for at most ${MAX_TARGETS} resources`,
    );
  }
  const unknown = targets.find((uri) => !resourceUris.includes(uri));
  if (unknown !== undefined) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      `"${unknown}" is not a resource of this tenant`,
    );
  }
  const subjects =
    input.subjectClients === "any" ? "any" : [...new Set(input.subjectClients)];
  if (subjects !== "any") {
    if (subjects.length > MAX_SUBJECT_CLIENTS) {
      throw new CatalogError(
        "BAD_USER_INPUT",
        `a client exchanges the tokens of at most ${MAX_SUBJECT_CLIENTS} clients`,
      );
    }
    const bad = subjects.find((id) => !SUBJECT_ID.test(id));
    if (bad !== undefined) {
      throw new CatalogError(
        "BAD_USER_INPUT",
        `"${bad}" is not a client id (a-z, 0-9 and "-")`,
      );
    }
  }
  return { targets, subjects };
}
