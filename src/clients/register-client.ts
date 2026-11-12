import {
  hashOAuthSecret,
  mintOAuthSecret,
  type OAuthClientRecord,
  redirectUriProblem,
} from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";
import {
  CliInputError,
  type CliTenant,
  SuspendedTenantError,
  UnknownTenantError,
} from "@/cli/errors";
import { partitionOf } from "@/modules/tenants/identity";

/**
 * The grants janus-oauth 0.8 offers to every client: it has no per-client
 * grant list, so the script only accepts these (and stores nothing for them).
 */
export const OFFERED_GRANTS = ["authorization_code", "refresh_token"] as const;
export type OfferedGrant = (typeof OFFERED_GRANTS)[number];

export interface RegisterClientInput {
  /** The tenant's slug. */
  tenant: string;
  name: string;
  redirectUris: readonly string[];
  /** `confidential` mints a secret (`client_secret_basic`); default `public` (PKCE only). */
  type?: "public" | "confidential";
  /**
   * The client's id inside the tenant, and the key of idempotency. Default: the
   * name, lowercased, as `a-z0-9-`. Re-running with the same id updates the client.
   */
  clientId?: string;
  /** Default: both offered grants. Anything else is refused. */
  grants?: readonly string[];
  /** Mint a new secret for an existing confidential client. */
  rotateSecret?: boolean;
}

export interface RegisteredClient {
  /** `true` when the client did not exist before. */
  created: boolean;
  tenant: string;
  clientId: string;
  name: string;
  redirectUris: readonly string[];
  type: "public" | "confidential";
  /** The plain secret, shown here once; `null` for a public client or an unchanged secret. */
  clientSecret: string | null;
}

export interface RegisterClientOptions {
  /** The plain driver `Db` of the janus OAuth collections (`oauthDb`). */
  db: Db;
  findTenant: (slug: string) => Promise<CliTenant | undefined>;
  now?: () => Date;
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** The default client id of a name: lowercase `a-z0-9-`. */
export const clientIdOf = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

function validate(input: RegisterClientInput): {
  name: string;
  clientId: string;
  redirectUris: string[];
} {
  const name = input.name.trim();
  if (name === "") throw new CliInputError("a client needs a name");
  const clientId = input.clientId ?? clientIdOf(name);
  if (!ID_PATTERN.test(clientId)) {
    throw new CliInputError(
      `client id "${clientId}" must be 1-64 characters of a-z, 0-9 and "-", not starting or ending with "-"`,
    );
  }
  const redirectUris = [...new Set(input.redirectUris)];
  if (redirectUris.length === 0) {
    throw new CliInputError("a client needs at least one redirect URI");
  }
  for (const uri of redirectUris) {
    const problem = redirectUriProblem(uri);
    if (problem !== null) {
      throw new CliInputError(`redirect URI "${uri}": ${problem}`);
    }
  }
  for (const grant of input.grants ?? OFFERED_GRANTS) {
    if (!(OFFERED_GRANTS as readonly string[]).includes(grant)) {
      throw new CliInputError(
        `grant "${grant}" is not offered: janus-oauth ${OFFERED_GRANTS.join(" and ")} only, for every client`,
      );
    }
  }
  return { name, clientId, redirectUris };
}

/**
 * Registers a client on a tenant, or updates it (ADR-0006: the client lives in
 * the tenant's partition of the janus collections, so no other tenant sees it).
 * Idempotent on `clientId`: the redirect URIs and the name are replaced by the
 * input's; an existing confidential client keeps its secret unless
 * `rotateSecret`. A confidential client's secret is returned once; janus keeps
 * only its hash.
 */
export async function registerClient(
  options: RegisterClientOptions,
  input: RegisterClientInput,
): Promise<RegisteredClient> {
  const { name, clientId, redirectUris } = validate(input);
  const type = input.type ?? "public";
  const tenant = await options.findTenant(input.tenant);
  if (tenant === undefined) throw new UnknownTenantError(input.tenant);
  if (tenant.status !== "active") throw new SuspendedTenantError(tenant.slug);

  const store = createMongoOAuth(options.db, {
    partition: partitionOf(tenant._id),
  });
  const existing = await store.findClient(clientId);
  if (existing !== null && existing.source !== "registered") {
    throw new CliInputError(`"${clientId}" is not a registered client`);
  }

  const confidential = type === "confidential";
  const existingHash = existing?.secretHash;
  if (!confidential && existingHash !== undefined) {
    throw new CliInputError(
      `"${clientId}" is a confidential client: re-run with --confidential, or use another client id (a client keeps its type)`,
    );
  }
  if (confidential && existing !== null && existingHash === undefined) {
    throw new CliInputError(
      `"${clientId}" is a public client: it cannot become confidential (a client keeps its type); register a confidential client under another client id`,
    );
  }
  if (!confidential && input.rotateSecret === true) {
    throw new CliInputError(
      `--rotate-secret needs a confidential client: "${clientId}" is public and has no secret`,
    );
  }
  // A confidential client's secret: kept (its stored hash) unless rotated or
  // new, else minted now and returned once.
  const keptHash = input.rotateSecret === true ? undefined : existingHash;
  const clientSecret =
    confidential && keptHash === undefined ? mintOAuthSecret() : null;
  const secretHash =
    keptHash ??
    (clientSecret === null ? undefined : hashOAuthSecret(clientSecret));
  const record: OAuthClientRecord = {
    id: clientId,
    name,
    redirectUris,
    source: "registered",
    createdAt: existing?.createdAt ?? (options.now ?? (() => new Date()))(),
    expiresAt: null,
    ...(confidential && secretHash !== undefined
      ? {
          tokenEndpointAuthMethod: "client_secret_basic" as const,
          secretHash,
        }
      : {}),
  };
  await store.upsertClient(record);
  return {
    created: existing === null,
    tenant: tenant.slug,
    clientId,
    name,
    redirectUris,
    type,
    clientSecret,
  };
}
