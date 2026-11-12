import {
  type RegisterResourceInput,
  registerResource,
  storedResourcesFor,
} from "@/modules/resources/register-resource";
import { issuerOf } from "@/modules/tenants/identity";
import { mongo } from "./db";
import { env } from "./env";
import { tenantBySlug } from "./tenancy";

/** The real `ResourcesFor`: the tenants' stored resources (`resources:create`). */
export const resourcesFor = storedResourcesFor(mongo.db.resources);

/**
 * `registerResource` bound to the real store, for the `resources:create`
 * script. The `resources` collection itself is not exported: it is
 * tenant-owned and reached only through the tenant's scope, which this
 * function and `resourcesFor` apply.
 */
export const registerStoredResource = (input: RegisterResourceInput) =>
  registerResource(
    {
      collection: mongo.db.resources,
      findTenant: tenantBySlug,
      issuerOf: (slug) =>
        issuerOf(slug, {
          scheme: env.CLAVIX_PUBLIC_SCHEME,
          domain: env.CLAVIX_DOMAIN,
          port: env.CLAVIX_PUBLIC_PORT,
        }),
    },
    input,
  );
