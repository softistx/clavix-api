import {
  hashOAuthSecret,
  mintOAuthSecret,
  type OAuthClientRecord,
  TOKEN_EXCHANGE_GRANT,
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
import { DEFAULT_GRANTS, usesRedirect } from "./grants";
import { validate } from "./validate";

export {
  DEFAULT_GRANTS,
  OFFERED_GRANTS,
  type OfferedGrant,
  usesRedirect,
} from "./grants";
export { clientIdOf } from "./validate";

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
  /**
   * The grants the client may use, enforced by janus. Default: what the
   * client already records, else `authorization_code` and `refresh_token`.
   * A list must name `authorization_code`, the device grant or the token
   * exchange grant (add `refresh_token` for a client that refreshes); anything
   * else is refused. The token exchange grant needs a confidential client.
   * A client with no `authorization_code` needs no redirect URI.
   */
  grants?: readonly string[];
  /** Mint a new secret for an existing confidential client. */
  rotateSecret?: boolean;
  /**
   * Make this client push its authorization requests to `/par` (RFC 9126), on
   * a tenant that does not require it of everyone. Default: what the client
   * already records, else `false`.
   */
  requirePar?: boolean;
  /**
   * Bind this client's tokens to a DPoP key (RFC 9449): its token requests must
   * carry a proof, whatever the tenant requires. Default: what the client
   * already records, else `false`.
   */
  dpopBound?: boolean;
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
  /** Whether the client must push its authorization requests. */
  requirePar: boolean;
  /** Whether the client's token requests must carry a DPoP proof. */
  dpopBound: boolean;
}

export interface RegisterClientOptions {
  /** The plain driver `Db` of the janus OAuth collections (`oauthDb`). */
  db: Db;
  findTenant: (slug: string) => Promise<CliTenant | undefined>;
  now?: () => Date;
}

/**
 * A confidential client's secret: kept (its stored hash) unless rotated or
 * new, else minted now and returned once (`clientSecret`).
 */
function secretOf(
  confidential: boolean,
  existingHash: string | undefined,
  rotate: boolean,
): { clientSecret: string | null; secretHash: string | undefined } {
  const keptHash = rotate ? undefined : existingHash;
  const clientSecret =
    confidential && keptHash === undefined ? mintOAuthSecret() : null;
  const secretHash =
    keptHash ??
    (clientSecret === null ? undefined : hashOAuthSecret(clientSecret));
  return { clientSecret, secretHash };
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
  const { name, clientId, redirectUris, grantTypes } = validate(input);
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

  // Judged on the grants the client will have: the input's, else the stored
  // ones (a re-run of a device-only client without --grants keeps them).
  if (
    redirectUris.length === 0 &&
    usesRedirect(grantTypes ?? existing?.grantTypes)
  ) {
    throw new CliInputError(
      "a client needs at least one redirect URI (a device-only or token-exchange-only client, --grants without authorization_code, needs none)",
    );
  }

  const confidential = type === "confidential";
  if (
    !confidential &&
    (grantTypes ?? existing?.grantTypes)?.includes(TOKEN_EXCHANGE_GRANT) ===
      true
  ) {
    throw new CliInputError(
      `the token exchange grant needs a confidential client (--confidential): "${clientId}" is not one`,
    );
  }
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
  const { clientSecret, secretHash } = secretOf(
    confidential,
    existingHash,
    input.rotateSecret === true,
  );
  const requirePar =
    input.requirePar ?? existing?.requirePushedAuthorizationRequests === true;
  const dpopBound = input.dpopBound ?? existing?.dpopBoundAccessTokens === true;
  const record: OAuthClientRecord = {
    id: clientId,
    name,
    redirectUris,
    source: "registered",
    createdAt: existing?.createdAt ?? (options.now ?? (() => new Date()))(),
    expiresAt: null,
    grantTypes: grantTypes ?? existing?.grantTypes ?? [...DEFAULT_GRANTS],
    ...(requirePar ? { requirePushedAuthorizationRequests: true } : {}),
    ...(dpopBound ? { dpopBoundAccessTokens: true } : {}),
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
    requirePar,
    dpopBound,
  };
}
