import {
  createOidcProvider,
  type OidcClaims,
  type OidcSubject,
} from "@softistx/janus-oidc";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { SUPPORTED_ACR } from "./authentication-level";
import type { ClaimsFor, RolesFor } from "./ports";

/** What the OIDC provider of the issuers reads of the options. */
export interface OidcOptions {
  claimsFor: ClaimsFor;
  rolesFor?: RolesFor;
}

/**
 * The claims of a tenant's user with its `roles` claim (slice A2c) when the
 * `rolesFor` port is given.
 */
async function withRoles(
  options: OidcOptions,
  tenant: ResolvedTenant,
  subject: OidcSubject,
  claims: OidcClaims | Promise<OidcClaims>,
): Promise<OidcClaims> {
  return options.rolesFor === undefined
    ? claims
    : {
        ...(await claims),
        roles: await options.rolesFor(tenant)(subject.id, null),
      };
}

/**
 * The OIDC provider the issuers share: claims of the tenant the issuer was
 * built for (`tenantOf`, issuer to tenant), roles included.
 */
export function oidcProviderOf(
  options: OidcOptions,
  tenantOf: ReadonlyMap<string, ResolvedTenant>,
) {
  return createOidcProvider({
    claims: (subject, scopes, { issuer }) => {
      const tenant = tenantOf.get(issuer);
      if (tenant === undefined) {
        throw new Error(`oidc: no tenant built for issuer ${issuer}`);
      }
      return withRoles(
        options,
        tenant,
        subject,
        options.claimsFor(tenant)(subject, scopes),
      );
    },
    // `openid` releases nothing else (`sub` aside), so roles go with every
    // OpenID Connect token, in the id_token as well as at userinfo.
    scopeClaims: { openid: ["roles"] },
    // D9: the `acr` values a client may ask for (`acr_values`, enforced at
    // approval, `authentication-level.ts`).
    acrValuesSupported: SUPPORTED_ACR,
    idToken: { includeClaims: true },
  });
}
