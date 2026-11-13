import { adminInvitationHooks } from "@/console/modules/admins/accept";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { createTenantAuth } from "@/users/tenant-auth";
import { access } from "./access";
import { exclusive } from "./exclusive";
import { secretBox } from "./keys";
import { oauthDb } from "./oauth-db";
import { tenantResolver, tenantsService } from "./tenancy";

// What accepting an invitation does: on the `clavix` tenant (the console's
// users) an admin invitation grants its console role; nothing more elsewhere.
const adminHooks = adminInvitationHooks({
  access,
  exclusive,
  tenantActive: async (id) =>
    (await tenantsService.activeByIds([id])).length === 1,
});

// The users of every tenant: one janus instance per tenant over its partition
// of the janus user stores (`syncMongoStoresPartitioned`). `authFor` and
// `claimsFor` are the ports of the OAuth issuers (`createIssuers`); the sign-in
// surface of slices 1.5 E1 and E2 plugs into `janusIssuers`.
export const { janusIssuers, authFor, claimsFor, forTenant } = createTenantAuth(
  {
    resolver: tenantResolver,
    db: oauthDb,
    secrets: secretBox,
    invitationHooks: (tenant) =>
      tenant.slug === PLATFORM_TENANT_SLUG ? adminHooks : undefined,
  },
);
