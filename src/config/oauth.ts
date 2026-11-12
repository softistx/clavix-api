import { createClavixOAuthIssuers } from "@/oauth/issuers";
import type { AuthFor, ClaimsFor, ResourcesFor } from "@/oauth/ports";
import { signingKeysFor } from "./keys";
import { oauthDb } from "./oauth-db";
import { resourcesFor as storedResourcesFor } from "./resources";
import { tenantResolver } from "./tenancy";

// The app's OAuth issuers with the real tenant resolver, database and signing
// keys and the tenants' stored resources (`resources:create`). The entry point
// calls this with the end-user authentication and claims (`authFor`,
// `claimsFor`) and passes the result to `createApp({ oauth })`.
export const createIssuers = (
  authFor: AuthFor,
  claimsFor: ClaimsFor,
  resourcesFor: ResourcesFor = storedResourcesFor,
) =>
  createClavixOAuthIssuers({
    resolver: tenantResolver,
    db: oauthDb,
    signingKeysFor,
    authFor,
    claimsFor,
    resourcesFor,
  });
