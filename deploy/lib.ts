/**
 * What deploy.ts shares with its specs: the stack's env file (read, checked,
 * refused when others can read it), the regex of the tenant hosts, the image
 * names it builds and the `docker compose` invocation of the staging stack.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { $ } from "bun";

export const DEPLOY_DIR = dirname(new URL(import.meta.url).pathname);
export const API_ROOT = resolve(DEPLOY_DIR, "..");
export const ENV_FILE = resolve(DEPLOY_DIR, ".env");

export function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** A flag's value (`--timeout 300`), or undefined. Exits on a flag with no value. */
export function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--"))
    fail(`${name} needs a value`);
  return value;
}

/** Why `path` cannot be the env file (missing, readable by others), or undefined. */
export function envFileProblem(path: string): string | undefined {
  if (!existsSync(path))
    return `${path} is missing: cp deploy/.env.example ${path}, fill it, chmod 600 ${path}`;
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600 && mode !== 0o400)
    return `${path} has mode ${mode.toString(8)}, it holds secrets: chmod 600 ${path}`;
  return undefined;
}

/**
 * KEY=VALUE lines; comments and blank lines skipped. A quoted value ends at its
 * closing quote; an unquoted one ends at a ` #`, as compose reads it.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(value);
    if (quoted) value = quoted[2] ?? "";
    else value = value.replace(/\s+#.*$/, "");
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** Variables the staging stack cannot start without. */
const REQUIRED = [
  "CLAVIX_DOMAIN",
  "CLAVIX_API_IMAGE",
  "CLAVIX_UI_IMAGE",
  "CLAVIX_KEYS_MASTER_KEY",
  "REDIS_PASSWORD",
  "MONGO_ROOT_PASSWORD",
  "MONGO_APP_PASSWORD",
  "MONGO_KEYFILE",
  "CONSOLE_SESSION_SECRET",
] as const;

/** What is wrong with the env file's values, one line each (empty when fine). */
export function envProblems(values: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const key of REQUIRED) {
    if (!values[key]) problems.push(`${key} is not set`);
  }
  const domain = values["CLAVIX_DOMAIN"];
  if (domain && !HOSTNAME.test(domain))
    problems.push(
      `CLAVIX_DOMAIN=${domain} is not a lower-case DNS name (no scheme, no port, no wildcard)`,
    );
  for (const key of ["CLAVIX_API_IMAGE", "CLAVIX_UI_IMAGE"] as const) {
    const image = values[key];
    if (image?.split("/")[0]?.includes("."))
      problems.push(
        `${key}=${image} names a registry: staging builds its images on the host, use a local name (clavix-api:staging)`,
      );
  }
  return problems;
}

/**
 * The regex of the tenant hosts (`<slug>.<domain>`, one label) for traefik's
 * HostRegexp, the domain's dots escaped. The domain is checked first.
 */
export function domainRegex(domain: string): string {
  if (!HOSTNAME.test(domain)) throw new Error(`not a DNS name: ${domain}`);
  return `^[a-z0-9-]+\\.${domain.replaceAll(".", "\\.")}$`;
}

/**
 * The environment of the compose process: the shell's, minus every name the env
 * file defines (compose reads those from `--env-file`, so a stale export cannot
 * win), plus what deploy.ts derives.
 */
export function composeEnv(
  shell: Record<string, string | undefined>,
  values: Record<string, string>,
  derived: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(shell)) {
    if (v !== undefined && !(k in values)) env[k] = v;
  }
  return { ...env, ...derived };
}

/** The UI checkout the image is built from, as an absolute path. */
export function uiContext(values: Record<string, string>): string {
  const ctx = values["CLAVIX_UI_CONTEXT"] || "../../clavix-ui";
  return isAbsolute(ctx) ? ctx : resolve(DEPLOY_DIR, ctx);
}

/** The repository part of an image reference (`clavix-api:staging` -> `clavix-api`). */
export function imageRepository(image: string): string {
  const slash = image.lastIndexOf("/");
  const colon = image.indexOf(":", slash + 1);
  return colon === -1 ? image : image.slice(0, colon);
}

/**
 * The image ids to remove after a deploy: every id listed under the app's
 * repositories (its previous tags included) that is not one of the current
 * images. `listed` are ids as `docker image ls -q` prints them.
 */
export function staleImageIds(
  listed: string[],
  current: Set<string>,
): string[] {
  const seen = new Set<string>();
  for (const id of listed) {
    const trimmed = id.trim();
    if (trimmed && !current.has(trimmed)) seen.add(trimmed);
  }
  return [...seen];
}

export type Stack = {
  values: Record<string, string>;
  /** The images this deploy builds and runs. */
  images: string[];
  compose: (...args: string[]) => ReturnType<typeof $>;
};

/**
 * Loads deploy/.env (it must exist and be mode 600, or the script refuses) and
 * returns the compose runner of the staging stack: compose.yml plus the traefik
 * overlay, so compose never starts caddy.
 */
export async function loadStack(): Promise<Stack> {
  const problem = envFileProblem(ENV_FILE);
  if (problem) return fail(problem);
  const values = parseEnv(await Bun.file(ENV_FILE).text());
  const issues = envProblems(values);
  if (issues.length > 0)
    return fail(`the env file ${ENV_FILE}:\n  ${issues.join("\n  ")}`);
  const derived: Record<string, string> = {
    CLAVIX_DOMAIN_RE: domainRegex(values["CLAVIX_DOMAIN"] as string),
  };
  const env = composeEnv(process.env, values, derived);
  const files = [
    "-f",
    `${DEPLOY_DIR}/compose.yml`,
    "-f",
    `${DEPLOY_DIR}/compose.traefik.yml`,
  ];
  return {
    values,
    images: [
      values["CLAVIX_API_IMAGE"] as string,
      values["CLAVIX_UI_IMAGE"] as string,
    ],
    compose: (...rest) =>
      $`docker compose ${files} --env-file ${ENV_FILE} ${rest}`
        .cwd(DEPLOY_DIR)
        .env(env),
  };
}
