import {
  CLIENT_CREDENTIALS_GRANT,
  DEVICE_GRANT,
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
import type { ClientDetailTypes } from "@/modules/resources/detail-types/client-opt-in";
import { partitionOf } from "@/modules/tenants/identity";
import { detailTypesOf } from "./detail-types";
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
  /**
   * The authorization detail types (RFC 9396) the client may ask for: each is a
   * type of the tenant, and the client must push its requests (`requirePar`).
   * Replaces the list; `[]` clears it. Default: what the client already
   * records, else none.
   */
  detailTypes?: readonly string[];
  /**
   * The scopes the client may ask for with the client credentials grant (the
   * ceiling: a request is cut to them). Needs that grant; replaces the list.
   * Default: what the client already records. A client with the grant needs
   * at least one.
   */
  allowedScopes?: readonly string[];
  /**
   * The scopes a client credentials request with no `scope` gets, within
   * `allowedScopes`. Default: what the client already records, else none.
   */
  defaultScopes?: readonly string[];
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
  /** The detail types the client may ask for. */
  detailTypes: readonly string[];
  /** The client credentials scope ceiling; empty without that grant. */
  allowedScopes: readonly string[];
  /** The client credentials default scopes; empty without that grant. */
  defaultScopes: readonly string[];
}

export interface RegisterClientOptions {
  /** The plain driver `Db` of the janus OAuth collections (`oauthDb`). */
  db: Db;
  findTenant: (slug: string) => Promise<CliTenant | undefined>;
  now?: () => Date;
  /** The tenant's detail types; without it a client cannot list any. */
  detailTypes?: ClientDetailTypes;
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
  const {
    name,
    clientId,
    redirectUris,
    grantTypes,
    allowedScopes,
    defaultScopes,
  } = validate(input);
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
      "a client needs at least one redirect URI (a device-only, token-exchange-only or client-credentials-only client, --grants without authorization_code, needs none)",
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
  const machineGrant =
    (grantTypes ?? existing?.grantTypes)?.includes(CLIENT_CREDENTIALS_GRANT) ===
    true;
  if (!confidential && machineGrant) {
    throw new CliInputError(
      `the client credentials grant needs a confidential client (--confidential): "${clientId}" is not one`,
    );
  }
  // Only a client with the grant has scopes for it; without it they are dropped.
  const machineScopes = machineGrant
    ? {
        allowed: allowedScopes ?? existing?.allowedScopes ?? [],
        default: defaultScopes ?? existing?.defaultScopes ?? [],
      }
    : { allowed: [], default: [] };
  if (
    !machineGrant &&
    ((allowedScopes?.length ?? 0) > 0 || (defaultScopes?.length ?? 0) > 0)
  ) {
    throw new CliInputError(
      `--allowed-scopes and --default-scopes belong to the ${CLIENT_CREDENTIALS_GRANT} grant, which "${clientId}" does not list`,
    );
  }
  if (machineGrant && machineScopes.allowed.length === 0) {
    throw new CliInputError(
      `the client credentials grant needs at least one allowed scope (--allowed-scopes): without one, every token request is invalid_scope`,
    );
  }
  const outside = machineScopes.default.filter(
    (scope) => !machineScopes.allowed.includes(scope),
  );
  if (outside.length > 0) {
    throw new CliInputError(
      `default scopes must be allowed scopes: ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not`,
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
  const grants = grantTypes ?? existing?.grantTypes ?? [...DEFAULT_GRANTS];
  const detailTypes = await detailTypesOf(
    options.detailTypes,
    tenant,
    input.detailTypes,
    existing?.authorizationDetailsTypes ?? [],
    {
      requirePar,
      hasConsent: usesRedirect(grants) || grants.includes(DEVICE_GRANT),
    },
  );
  const record: OAuthClientRecord = {
    id: clientId,
    name,
    redirectUris,
    source: "registered",
    createdAt: existing?.createdAt ?? (options.now ?? (() => new Date()))(),
    expiresAt: null,
    grantTypes: grants,
    ...(requirePar ? { requirePushedAuthorizationRequests: true } : {}),
    ...(dpopBound ? { dpopBoundAccessTokens: true } : {}),
    ...(detailTypes.length > 0
      ? { authorizationDetailsTypes: detailTypes }
      : {}),
    ...(machineScopes.allowed.length > 0
      ? { allowedScopes: machineScopes.allowed }
      : {}),
    ...(machineScopes.default.length > 0
      ? { defaultScopes: machineScopes.default }
      : {}),
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
    detailTypes,
    allowedScopes: machineScopes.allowed,
    defaultScopes: machineScopes.default,
  };
}
