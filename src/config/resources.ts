import { ObjectId } from "mongodb";
import type { DetailTextsFor, ScopeTextsFor } from "@/modules/consent";
import {
  mongoClientDetailTypes,
  mongoDetailTypeClients,
  mongoScopeClients,
  type RegisterResourceInput,
  ResourcesService,
} from "@/modules/resources";
import { issuerOf } from "@/modules/tenants";
import { userinfoOf } from "@/oauth/building";
import { adminEventRecorder } from "./admin-events";
import { mongo } from "./db";
import { env } from "./env";
import { oauthDb } from "./oauth-db";
import { rolesService } from "./roles";
import { tenantBySlug, tenantResolver } from "./tenancy";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;

/**
 * A tenant's resources, scopes and detail types (console, `resources:create`,
 * the token server). The collections are tenant-owned and not exported: only
 * this service reaches them, through the tenant's scope.
 */
export const resourcesService = new ResourcesService({
  resources: mongo.db.resources,
  scopes: mongo.db.scopes,
  detailTypes: mongo.db.detailTypes,
  clients: mongoDetailTypeClients(oauthDb),
  scopeClients: mongoScopeClients(oauthDb),
  rolesGranting: (tenantId, scopeId) =>
    rolesService.rolesGranting(tenantId, scopeId),
  userinfoOf: (slug) => userinfoOf(issuerOf(slug, origin)),
  findTenant: tenantBySlug,
  // The `resources:create` script's replace of the scopes: the roles let go of
  // the dropped ones, each recorded like the console's own cascade.
  scopesDropped: async (tenantId, scopeIds) => {
    const pulled = await rolesService.pullScopes(tenantId, scopeIds);
    const requestId = crypto.randomUUID();
    for (const role of pulled) {
      await adminEventRecorder.record({
        actor: "script:resources:create",
        action: "role.setPermissions",
        tenantId: tenantId.toHexString(),
        target: { type: "role", id: role._id.toHexString() },
        requestId,
      });
    }
  },
});

/** The real `ResourcesFor`: the tenants' stored resources and their scopes (console, `resources:create`). */
export const resourcesFor = resourcesService.storedFor;

/** `registerResource` bound to the real store, for the `resources:create` script. */
export const registerStoredResource = (input: RegisterResourceInput) =>
  resourcesService.registerResource(input);

/** The tenant's scope texts the consent page shows, for the request's host. */
export const scopeTextsFor: ScopeTextsFor = async (request) => {
  const tenant = await tenantResolver.resolveRequest(request);
  if (tenant === null) return [];
  const tenantId = new ObjectId(tenant.tenantId);
  const [scopes, resources] = await Promise.all([
    resourcesService.listScopes(tenantId),
    resourcesService.listResources(tenantId),
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

/** The tenant's detail type texts the consent page shows, for the request's host. */
export const detailTextsFor: DetailTextsFor = async (request) => {
  const tenant = await tenantResolver.resolveRequest(request);
  if (tenant === null) return [];
  const types = await resourcesService.listDetailTypes(
    new ObjectId(tenant.tenantId),
  );
  return types.map(({ type, name, description, fields, actions }) => ({
    type,
    name,
    description,
    fields,
    actions,
  }));
};

/** What a client's detail type opt-in reads: the tenant's stored types. */
export const clientDetailTypes = mongoClientDetailTypes(mongo.db.detailTypes);
