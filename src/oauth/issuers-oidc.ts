import {
  createOidcProvider,
  type OidcClaims,
  type OidcScopeClaims,
  type OidcSubject,
} from "@softistx/janus-oidc";
import { RESERVED_CLAIMS } from "@/modules/attributes";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { SUPPORTED_ACR } from "./authentication-level";
import type {
  AttributeScopesFor,
  AttributesFor,
  ClaimsFor,
  RolesFor,
} from "./ports";

/** What the OIDC provider of the issuers reads of the options. */
export interface OidcOptions {
  claimsFor: ClaimsFor;
  rolesFor: RolesFor;
  attributesFor: AttributesFor;
  attributeScopesFor: AttributeScopesFor;
}

/**
 * The claims of a tenant's user: the attribute claims (slice A6, those whose
 * emission scope the token holds, and the tenant-wide roles for a role
 * attribute), under the user's own claims and its `roles` (slice A2c), which
 * win over an attribute of the same name.
 */
async function withExtras(
  options: OidcOptions,
  tenant: ResolvedTenant,
  subject: OidcSubject,
  scopes: readonly string[],
  claims: OidcClaims | Promise<OidcClaims>,
): Promise<OidcClaims> {
  const [own, attributes, roles] = await Promise.all([
    claims,
    options.attributesFor(tenant)(subject.id, scopes, null),
    options.rolesFor(tenant)(subject.id, null),
  ]);
  return { ...omitReserved(attributes), ...own, roles };
}

const RESERVED: ReadonlySet<string> = new Set(RESERVED_CLAIMS);

/** The claims without the names an attribute may never take (a catalogue refuses them at creation; this keeps a token valid whatever the data). */
const omitReserved = (claims: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(claims).filter(([name]) => !RESERVED.has(name)),
  );

/**
 * Temporary, until softistx/janus#1049: janus replaces a standard scope's list
 * with the tenant's table, so a table naming `profile`, `email`, `address` or
 * `phone` would stop releasing `name`, `picture`, `email`... Clavix seeds the
 * table with janus's standard lists and adds the attribute keys to them.
 * `openid` releases nothing else (`sub` aside), so roles go with every OpenID
 * Connect token.
 */
const BASE_SCOPE_CLAIMS: OidcScopeClaims = {
  openid: ["roles"],
  profile: [
    "name",
    "family_name",
    "given_name",
    "middle_name",
    "nickname",
    "preferred_username",
    "profile",
    "picture",
    "website",
    "gender",
    "birthdate",
    "zoneinfo",
    "locale",
    "updated_at",
  ],
  email: ["email", "email_verified"],
  address: ["address"],
  phone: ["phone_number", "phone_number_verified"],
};

/** The base table with the attribute scopes added: a scope listed in both releases both lists. */
export function scopeClaimsOf(
  attributes: Readonly<Record<string, readonly string[]>>,
): OidcScopeClaims {
  const table: Record<string, readonly string[]> = { ...BASE_SCOPE_CLAIMS };
  for (const [scope, listed] of Object.entries(attributes)) {
    const keys = listed.filter((key) => !RESERVED.has(key));
    table[scope] = [...new Set([...(table[scope] ?? []), ...keys])];
  }
  return table;
}

/**
 * The OIDC provider the issuers share: claims of the tenant the issuer was
 * built for (`tenantOf`, issuer to tenant), roles and attributes included.
 * The scope table is the tenant's too (janus asks it on every discovery
 * document, userinfo request and ID token), so an attribute's emission scope
 * releases its claim there and is listed in `claims_supported`.
 */
export function oidcProviderOf(
  options: OidcOptions,
  tenantOf: ReadonlyMap<string, ResolvedTenant>,
) {
  const tenantFor = (issuer: string): ResolvedTenant => {
    const tenant = tenantOf.get(issuer);
    if (tenant === undefined) {
      throw new Error(`oidc: no tenant built for issuer ${issuer}`);
    }
    return tenant;
  };
  return createOidcProvider({
    claims: (subject, scopes, { issuer }) => {
      const tenant = tenantFor(issuer);
      return withExtras(
        options,
        tenant,
        subject,
        scopes,
        options.claimsFor(tenant)(subject, scopes),
      );
    },
    scopeClaims: async ({ issuer }) =>
      scopeClaimsOf(await options.attributeScopesFor(tenantFor(issuer))()),
    // D9: the `acr` values a client may ask for (`acr_values`, enforced at
    // approval, `authentication-level.ts`).
    acrValuesSupported: SUPPORTED_ACR,
    idToken: { includeClaims: true },
  });
}
