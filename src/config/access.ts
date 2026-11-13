import { createMongoRelations } from "@softistx/janus-mongo";
import { createAccess } from "@/console/access";
import { oauthDb } from "./oauth-db";

// The console's permissions: janus relations in the app's database (the
// `relations` collection, synced by `db:sync`). Users are the `clavix` tenant's,
// objects are the platform and the tenants' hex ids, so nothing here is
// partitioned.
export const access = createAccess(createMongoRelations(oauthDb));

/** Links a new tenant to the platform, so a platform role carries over to it. */
export const linkTenantToPlatform = (tenantId: string) =>
  access.linkTenant(tenantId);
