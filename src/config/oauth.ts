import { createClavixOAuthIssuers } from "@/oauth/issuers";
import type { AuthFor, ClaimsFor, ResourcesFor, RolesFor } from "@/oauth/ports";
import { withTenantState } from "@/oauth/tenant-state";
import { signingKeysFor } from "./keys";
import { oauthDb } from "./oauth-db";
import { resourcesFor as storedResourcesFor } from "./resources";
import { rolesFor as storedRolesFor } from "./roles";
import { tenantResolver } from "./tenancy";
import { usageService } from "./usage";

// The app's OAuth issuers with the real tenant resolver, database and signing
// keys and the tenants' stored resources (`resources:create`). The entry point
// calls this with the end-user authentication and claims (`authFor`,
// `claimsFor`) and passes the result to `createApp({ oauth })`. A suspended or
// deleted tenant's `/authorize` and `/token` are refused, and a token issued
// counts its user as active this month (`withTenantState`).
export const createIssuers = (
  authFor: AuthFor,
  claimsFor: ClaimsFor,
  resourcesFor: ResourcesFor = storedResourcesFor,
  rolesFor: RolesFor = storedRolesFor,
) =>
  withTenantState(
    createClavixOAuthIssuers({
      resolver: tenantResolver,
      db: oauthDb,
      signingKeysFor,
      authFor,
      claimsFor,
      resourcesFor,
      rolesFor,
    }),
    {
      resolver: tenantResolver,
      onActive: (tenantId, userId) =>
        usageService.recordActive(tenantId, userId),
    },
  );
