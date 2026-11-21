import { userKey } from "@/console/modules/user-key";
import { janusListener } from "@/events/janus-listener";
import { adminInvitationHooks } from "@/modules/admins/admins.hooks";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { secondFactorKeysOf } from "@/modules/users/second-factor-keys";
import { createTenantAuth } from "@/modules/users/tenant-auth";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { access } from "./access";
import { connectionsService } from "./connections";
import { eventBus } from "./events";
import { exclusive } from "./exclusive";
import { masterKeys, secretBox } from "./keys";
import { oauthDb } from "./oauth-db";
import { warn } from "./runtime";
import { tenantResolver, tenantsService } from "./tenancy";

// What accepting an invitation does: on the `clavix` tenant (the console's
// users) an admin invitation grants its console role; nothing more elsewhere.
const adminHooks = (tenant: ResolvedTenant) =>
  adminInvitationHooks({
    access,
    exclusive,
    userLock: (id) => userKey(tenant.tenantId, id),
    tenantActive: async (id) =>
      (await tenantsService.activeByIds([id])).length === 1,
    // These hooks only serve the `clavix` tenant: `tenant` is it.
    findUser: async (id) =>
      (await (await forTenant(tenant))?.findUser(id)) ?? null,
  });

// The users of every tenant: one janus instance per tenant over its partition
// of the janus user stores (`syncMongoStoresPartitioned`). `authFor` and
// `claimsFor` are the ports of the OAuth issuers (`createIssuers`); the sign-in
// surface of slices 1.5 E1 and E2 plugs into `janusIssuers`.
export const { janusIssuers, authFor, claimsFor, forTenant } = createTenantAuth(
  {
    resolver: tenantResolver,
    db: oauthDb,
    log: warn,
    secondFactorKeys: secondFactorKeysOf(masterKeys),
    secrets: secretBox,
    connections: connectionsService,
    events: (tenant) => janusListener(tenant.tenantId, eventBus),
    invitationHooks: (tenant) =>
      tenant.slug === PLATFORM_TENANT_SLUG ? adminHooks(tenant) : undefined,
  },
);
