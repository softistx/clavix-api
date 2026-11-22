import type { OidcClaims } from "@softistx/janus-oidc";
import { pictureUrl } from "@/modules/media/media.utils";
import { profileOf, standardClaims } from "@/modules/profile";
import type { AuthFor, ClaimsFor } from "@/oauth/ports";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import {
  createTenantJanusIssuers,
  type TenantJanusOptions,
} from "./users.issuers";

/**
 * The real `AuthFor` and `ClaimsFor` ports (slice 1.5): both look a user up in
 * the janus instance of its own tenant, so a session, a user id or a token
 * subject of another tenant is anonymous or unknown here.
 */
export function createTenantAuth(options: TenantJanusOptions) {
  const janusIssuers = createTenantJanusIssuers(options);
  // The tenant's own host as a request, to reach its instance without a caller's request.
  const forTenant = (tenant: ResolvedTenant) =>
    janusIssuers.forRequest(new Request(tenant.issuer));

  const authFor: AuthFor = (tenant) => ({
    // The tenant's own instance, not one picked from the request: the server
    // is the tenant's, and its sessions live in the tenant's partition.
    authenticate: async (request) =>
      (await forTenant(tenant))?.authenticate(request) ?? null,
    findUser: async (id) => (await forTenant(tenant))?.findUser(id) ?? null,
  });

  const claimsFor: ClaimsFor = (tenant) => async (subject) => {
    const user = await (await forTenant(tenant))?.findUser(subject.id);
    if (user === null || user === undefined) return {}; // not in this tenant's pool: nothing to release
    const profile = profileOf(user);
    const claims: OidcClaims = {
      email: user.email,
      email_verified: user.emailVerified,
      ...(user.name === undefined ? {} : { name: user.name }),
      // janus-oidc releases each by scope: `profile`, `phone`, `address`.
      ...standardClaims(profile),
      ...(profile.pictureKey === null
        ? {}
        : { picture: pictureUrl(tenant.issuer, profile.pictureKey) }),
    };
    return claims;
  };

  return { janusIssuers, authFor, claimsFor, forTenant };
}
