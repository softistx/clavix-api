/**
 * Reads a GraphQL response body by dotted path (`"verifySignInCode.user.id"`)
 * and returns it typed by the caller, `unknown` by default: a spec names what
 * it expects, a missing step gives `undefined` instead of a throw.
 */
export const at = <T = unknown>(
  data: Record<string, unknown> | null | undefined,
  path: string,
): T => {
  let node: unknown = data;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined as T;
    node = (node as Record<string, unknown>)[key];
  }
  return node as T;
};
