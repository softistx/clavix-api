import {
  DEVICE_GRANT,
  hashOAuthSecret,
  mintOAuthSecret,
  type OAuthClientGrantType,
  type OAuthClientRecord,
} from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { CatalogError } from "@/modules/resources";
import { partitionOf } from "@/modules/tenants";
import {
  CliInputError,
  type CliTenant,
  SuspendedTenantError,
  UnknownTenantError,
} from "@/shared/cli";
import { detailTypesOf } from "./clients.detail-types";
import { DEFAULT_GRANTS, usesRedirect } from "./clients.rules";
import type {
  RegisterClientInput,
  RegisterClientOptions,
  RegisteredClient,
} from "./clients.types";
import {
  checkGrants,
  checkType,
  machineScopesOf,
  validate,
} from "./clients.validate";

type Store = ReturnType<typeof createMongoOAuth>;
type Checked = ReturnType<typeof validate>;
type Scopes = ReturnType<typeof machineScopesOf>;

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

/** The tenant of a registration: it exists and is active. */
async function tenantOf(
  options: RegisterClientOptions,
  slug: string,
): Promise<CliTenant> {
  const tenant = await options.findTenant(slug);
  if (tenant === undefined) throw new UnknownTenantError(slug);
  if (tenant.status !== "active") throw new SuspendedTenantError(tenant.slug);
  return tenant;
}

/** The client's stored record, when it is one this script and the console manage. */
async function storedOf(store: Store, clientId: string) {
  const existing = await store.findClient(clientId);
  if (existing !== null && existing.source !== "registered") {
    throw new CliInputError(`"${clientId}" is not a registered client`);
  }
  return existing;
}

/** The record to store: what the input sets over what the client already has. */
function recordOf(
  checked: Checked,
  existing: OAuthClientRecord | null,
  settings: {
    grants: readonly OAuthClientGrantType[];
    requirePar: boolean;
    dpopBound: boolean;
    detailTypes: readonly string[];
    scopes: Scopes;
    secretHash: string | undefined;
  },
  now: () => Date,
): OAuthClientRecord {
  const { requirePar, dpopBound, detailTypes, scopes, secretHash } = settings;
  return {
    id: checked.clientId,
    name: checked.name,
    redirectUris: checked.redirectUris,
    source: "registered",
    createdAt: existing?.createdAt ?? now(),
    expiresAt: null,
    grantTypes: [...settings.grants],
    ...(requirePar ? { requirePushedAuthorizationRequests: true } : {}),
    ...(dpopBound ? { dpopBoundAccessTokens: true } : {}),
    ...(detailTypes.length > 0
      ? { authorizationDetailsTypes: [...detailTypes] }
      : {}),
    ...(scopes.allowed.length > 0 ? { allowedScopes: scopes.allowed } : {}),
    ...(scopes.default.length > 0 ? { defaultScopes: scopes.default } : {}),
    ...(secretHash === undefined
      ? {}
      : {
          tokenEndpointAuthMethod: "client_secret_basic" as const,
          secretHash,
        }),
  };
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
  const checked = validate(input);
  const { clientId } = checked;
  const tenant = await tenantOf(options, input.tenant);
  const store = createMongoOAuth(options.db, {
    partition: partitionOf(tenant._id),
  });
  const existing = await storedOf(store, clientId);
  const confidential = (input.type ?? "public") === "confidential";
  const machineGrant = checkGrants(checked, confidential, existing);
  const scopes = machineScopesOf(checked, machineGrant, existing);
  checkType(clientId, confidential, existing, input.rotateSecret === true);
  const { clientSecret, secretHash } = secretOf(
    confidential,
    existing?.secretHash,
    input.rotateSecret === true,
  );
  const requirePar =
    input.requirePar ?? existing?.requirePushedAuthorizationRequests === true;
  const dpopBound = input.dpopBound ?? existing?.dpopBoundAccessTokens === true;
  const grants = checked.grantTypes ??
    existing?.grantTypes ?? [...DEFAULT_GRANTS];
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
  await store.upsertClient(
    recordOf(
      checked,
      existing,
      { grants, requirePar, dpopBound, detailTypes, scopes, secretHash },
      options.now,
    ),
  );
  return {
    created: existing === null,
    tenant: tenant.slug,
    clientId,
    name: checked.name,
    redirectUris: checked.redirectUris,
    type: confidential ? "confidential" : "public",
    clientSecret,
    requirePar,
    dpopBound,
    detailTypes,
    allowedScopes: scopes.allowed,
    defaultScopes: scopes.default,
  };
}

/**
 * Registers (or re-registers) a client of one tenant through the script's
 * `registerClient`, so a console client follows the same rules; a rejected
 * input becomes a `BAD_USER_INPUT` catalog error.
 */
export function registerForTenant(
  options: Omit<RegisterClientOptions, "findTenant">,
  tenant: CliTenant,
  input: Omit<RegisterClientInput, "tenant">,
): Promise<RegisteredClient> {
  return registerClient(
    {
      ...options,
      findTenant: async (slug) => (slug === tenant.slug ? tenant : undefined),
    },
    { ...input, tenant: tenant.slug },
  ).catch((error) => {
    if (error instanceof CliInputError) {
      throw new CatalogError("BAD_USER_INPUT", error.message);
    }
    throw error;
  });
}
