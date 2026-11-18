import { ObjectId } from "mongodb";
import type { ScopeTextsFor } from "@/modules/consent/scope-labels";
import { Catalog } from "@/modules/resources/catalog";
import {
  type RegisterResourceInput,
  registerResource,
  storedResourcesFor,
} from "@/modules/resources/register-resource";
import { issuerOf } from "@/modules/tenants/identity";
import { userinfoOf } from "@/oauth/building";
import { mongo } from "./db";
import { env } from "./env";
import { tenantBySlug, tenantResolver } from "./tenancy";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;

/** The real `ResourcesFor`: the tenants' stored resources and their scopes (console, `resources:create`). */
export const resourcesFor = storedResourcesFor(
  mongo.db.resources,
  mongo.db.scopes,
  mongo.db.detailTypes,
);

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
      scopes: mongo.db.scopes,
      findTenant: tenantBySlug,
      issuerOf: (slug) => issuerOf(slug, origin),
    },
    input,
  );

/** A tenant's resources and scopes, for the console. */
export const catalog = new Catalog({
  resources: mongo.db.resources,
  scopes: mongo.db.scopes,
  userinfoOf: (slug) => userinfoOf(issuerOf(slug, origin)),
});

/** The tenant's scope texts the consent page shows, for the request's host. */
export const scopeTextsFor: ScopeTextsFor = async (request) => {
  const tenant = await tenantResolver.resolveRequest(request);
  if (tenant === null) return [];
  const tenantId = new ObjectId(tenant.tenantId);
  const [scopes, resources] = await Promise.all([
    catalog.listScopes(tenantId),
    catalog.listResources(tenantId),
  ]);
  const uris = new Map(
    resources.map((resource) => [resource._id.toHexString(), resource.uri]),
  );
  return scopes.flatMap((scope) => {
    const resource =
      scope.resourceId === null
        ? null
        : uris.get(scope.resourceId.toHexString());
    return resource === undefined
      ? []
      : [{ name: scope.name, resource, description: scope.description }];
  });
};
