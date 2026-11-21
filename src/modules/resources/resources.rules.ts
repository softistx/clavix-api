import { CliInputError } from "@/shared/cli";
import { isOneOf, unique } from "@/shared/values";
import { CatalogError } from "./resources.errors";
import type { RegisterResourceInput, StoredScopeDoc } from "./resources.types";

export const MAX_NAME = 100;
export const MAX_DESCRIPTION = 300;
/** The longest label (a type or a field name, an enum value or an action label). */
export const MAX_LABEL = 100;
const MAX_CLAIMS = 50;

/**
 * The scopes of the userinfo resource (`src/oauth/building.ts`): the standard
 * OpenID Connect ones, built in and owned by no resource.
 */
export const OIDC_SCOPES = ["openid", "profile", "email"] as const;

export const isOidcScope = (name: string): boolean =>
  isOneOf(OIDC_SCOPES, name);

/** Loopback hosts: `localhost` and `*.localhost` (RFC 6761), 127.0.0.1, [::1]. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]"
  );
}

/** The resource URI's problem (RFC 8707 §2: absolute, no fragment), or `null`. */
export function resourceUriProblem(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "must be an absolute URI";
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return "must be https (http only on a loopback host)";
  }
  if (url.hash !== "" || uri.includes("#")) return "must have no fragment";
  if (url.username !== "" || url.password !== "") {
    return "must carry no credentials";
  }
  return null;
}

// Same shape as an OAuth scope token (RFC 6749 §3.3): printable ASCII, no
// space, quote or backslash.
const SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** The scope name's problem, or `null`. */
export function scopeNameProblem(name: string): string | null {
  return SCOPE_PATTERN.test(name)
    ? null
    : `scope "${name}" must be printable ASCII without space, quote or backslash`;
}

/**
 * Two spellings of one URL (case of scheme and host, default port, empty path,
 * dot segments) are the same resource.
 */
export const sameUri = (a: string, b: string): boolean =>
  new URL(a).href === new URL(b).href;

function refuse(message: string): never {
  throw new CatalogError("BAD_USER_INPUT", message);
}

export function cleanClaims(claims: readonly string[] | undefined): string[] {
  const clean = unique((claims ?? []).map((claim) => claim.trim()));
  if (clean.length > MAX_CLAIMS || clean.some((c) => c.length > MAX_NAME)) {
    refuse(
      `a scope has at most ${MAX_CLAIMS} claims of ${MAX_NAME} characters`,
    );
  }
  return clean;
}

export function cleanText(text: string | undefined): string | undefined {
  const clean = text?.trim();
  if ((clean?.length ?? 0) > MAX_DESCRIPTION) {
    refuse(`a description has at most ${MAX_DESCRIPTION} characters`);
  }
  return clean;
}

export function cleanName(name: string): string {
  const clean = name.trim();
  if (clean === "") refuse("a resource needs a name");
  if (clean.length > MAX_NAME) {
    refuse(`a name has at most ${MAX_NAME} characters`);
  }
  return clean;
}

/**
 * The console's resource URI, trimmed: absolute, canonical and not the
 * tenant's userinfo endpoint (`userinfoUrl`), or a `BAD_USER_INPUT`.
 */
export function checkResourceUri(raw: string, userinfoUrl: string): string {
  const uri = raw.trim();
  const problem = resourceUriProblem(uri);
  if (problem !== null) refuse(`resource URI "${uri}": ${problem}`);
  const canonical = new URL(uri).href;
  if (canonical !== uri) {
    refuse(
      `resource URI "${uri}" is not in canonical form: write it as ${canonical}`,
    );
  }
  if (sameUri(uri, userinfoUrl)) {
    refuse(`"${uri}" is the tenant's userinfo endpoint, a built-in resource`);
  }
  return uri;
}

/** A new scope's name, trimmed and checked, or a `BAD_USER_INPUT`. */
export function checkScopeName(raw: string): string {
  const name = raw.trim();
  if (name === "") refuse("a scope needs a name");
  if (name.length > MAX_NAME) {
    refuse(`a name has at most ${MAX_NAME} characters`);
  }
  const problem = scopeNameProblem(name);
  if (problem !== null) refuse(problem);
  return name;
}

/** Whether a stored scope is the very definition a repeated create asks for. */
export function sameScopeDefinition(
  existing: StoredScopeDoc,
  description: { fr: string; en: string },
  claims: readonly string[],
): boolean {
  return (
    existing.description.fr === description.fr &&
    existing.description.en === description.en &&
    existing.claims.length === claims.length &&
    existing.claims.every((claim) => claims.includes(claim))
  );
}

/**
 * A registration's input as the script means it: URI, scopes (deduplicated,
 * at least one) and name checked, or a `CliInputError`.
 */
export function checkRegistration(input: RegisterResourceInput) {
  const uri = input.uri.trim();
  const problem = resourceUriProblem(uri);
  if (problem !== null) {
    throw new CliInputError(`resource URI "${uri}": ${problem}`);
  }
  const scopes = unique(input.scopes.map((scope) => scope.trim()));
  if (scopes.length === 0 || scopes.includes("")) {
    throw new CliInputError("a resource needs at least one scope");
  }
  for (const scope of scopes) {
    const scopeProblem = scopeNameProblem(scope);
    if (scopeProblem !== null) throw new CliInputError(scopeProblem);
  }
  const name = (input.name ?? new URL(uri).host).trim();
  if (name === "") throw new CliInputError("a resource needs a name");
  return { uri, name, scopes };
}

/**
 * The registration's URI must be written in canonical form: `.href` adds "/"
 * to a bare origin, which would change the audience the clients already
 * request, so it is refused rather than rewritten.
 */
export function checkCanonicalRegistration(uri: string, userinfoUrl: string) {
  if (sameUri(uri, userinfoUrl)) {
    throw new CliInputError(
      `"${uri}" is the tenant's userinfo endpoint, a built-in resource`,
    );
  }
  const canonical = new URL(uri).href;
  if (canonical !== uri) {
    throw new CliInputError(
      `resource URI "${uri}" is not in canonical form: write it as ${canonical}`,
    );
  }
}
