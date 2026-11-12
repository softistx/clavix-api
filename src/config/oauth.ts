import { createClavixOAuthIssuers } from "@/oauth/issuers";
import type { AuthFor, ResourcesFor } from "@/oauth/ports";
import { signingKeysFor } from "./keys";
import { oauthDb } from "./oauth-db";
import { tenantResolver } from "./tenancy";

// The app's OAuth issuers with the real tenant resolver, database and signing
// keys. The end-user authentication (`authFor`, slice 1.5) and the tenants'
// resources are the only parts still to come: the entry point calls this with
// them and passes the result to `createApp({ oauth })`.
export const createIssuers = (authFor: AuthFor, resourcesFor?: ResourcesFor) =>
  createClavixOAuthIssuers({
    resolver: tenantResolver,
    db: oauthDb,
    signingKeysFor,
    authFor,
    ...(resourcesFor === undefined ? {} : { resourcesFor }),
  });
