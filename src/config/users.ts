import { createTenantAuth } from "@/users/tenant-auth";
import { secretBox } from "./keys";
import { oauthDb } from "./oauth-db";
import { tenantResolver } from "./tenancy";

// The users of every tenant: one janus instance per tenant over its partition
// of the janus user stores (`syncMongoStoresPartitioned`). `authFor` and
// `claimsFor` are the ports of the OAuth issuers (`createIssuers`); the sign-in
// surface of slices 1.5 E1 and E2 plugs into `janusIssuers`.
export const { janusIssuers, authFor, claimsFor, forTenant } = createTenantAuth(
  {
    resolver: tenantResolver,
    db: oauthDb,
    secrets: secretBox,
  },
);
