import { ObjectId } from "mongodb";
import { clientPoliciesService } from "@/config/client-policies";
import { env } from "@/config/env";
import { resourcesService } from "@/config/resources";
import { rolesService } from "@/config/roles";
import { tenantResolver } from "@/config/tenancy";
import type { ConsoleContext } from "@/console/context";
import { refusing } from "@/console/modules/catalog-support";
import { keepConsoleResource } from "@/console/modules/reserved";
import type { CliTenant } from "@/shared/cli";
import { hostOf } from "../tenants";
import { protectedResourceDocument } from "./resources.protected-document";
import type { StoredResourceDoc, StoredScopeDoc } from "./resources.types";
import { resourceShape, target } from "./resources.utils";

// The RFC 9728 documents of a tenant's resources: the tenant's issuer (its
// primary host when it has one) and DPoP policy come from the resolved
// tenant, read once per request however many resources it shows. A host that
// does not resolve gives `null` documents, never an error.
export const documentsOf = (slug: string) => {
  let tenant: ReturnType<typeof tenantResolver.resolveHost> | undefined;
  return async (resource: StoredResourceDoc, scopes: StoredScopeDoc[]) => {
    tenant ??= tenantResolver.resolveHost(hostOf(slug, env.CLAVIX_DOMAIN));
    const resolved = await tenant;
    if (resolved === null) return null;
    return protectedResourceDocument({
      uri: resource.uri,
      issuer: resolved.issuer,
      scopes: scopes
        .filter((scope) => scope.resourceId?.equals(resource._id))
        .map((scope) => scope.name),
      dpopRequired: resolved.oauth.dpop.required,
    });
  };
};

/** Every resource of a tenant with its scopes and detail types, read once for all of them. */
export async function showResources(tenant: CliTenant) {
  const [found, scopes, types] = await Promise.all([
    resourcesService.listResources(tenant._id),
    resourcesService.listScopes(tenant._id),
    resourcesService.listDetailTypes(tenant._id),
  ]);
  const documentOf = documentsOf(tenant.slug);
  return Promise.all(
    found.map(async (resource) =>
      resourceShape(
        resource,
        scopes,
        types,
        await documentOf(resource, scopes),
      ),
    ),
  );
}

/** A stored resource with its own scopes and detail types, as the console shows it. */
export async function showResource(
  tenant: CliTenant,
  resource: StoredResourceDoc,
) {
  const scopes = await resourcesService.listScopes(tenant._id, {
    resourceId: resource._id,
  });
  const types = await resourcesService.listDetailTypes(tenant._id, {
    resourceId: resource._id,
  });
  return resourceShape(
    resource,
    scopes,
    types,
    await documentsOf(tenant.slug)(resource, scopes),
  );
}

/**
 * Deletes a resource and what hangs on it, then records the trail: one event
 * for each role scoped to it, each scope and each detail type, and the
 * resource's own (recorded on a repeat too: it may be the event the first run
 * missed).
 */
export async function removeResource(
  ctx: ConsoleContext,
  tenant: CliTenant,
  id: string,
) {
  let scopes: StoredScopeDoc[] = [];
  let types: Awaited<ReturnType<typeof resourcesService.listDetailTypes>> = [];
  const removed = await refusing(async () => {
    const found = await resourcesService.findResource(tenant._id, id);
    keepConsoleResource(tenant, found);
    if (found !== undefined) {
      scopes = await resourcesService.listScopes(tenant._id, {
        resourceId: found._id,
      });
      types = await resourcesService.listDetailTypes(tenant._id, {
        resourceId: found._id,
      });
      // The roles scoped to it go first: were the resource gone before them
      // a retry would find nothing to clean up.
      const roles = await rolesService.deleteForResource(tenant._id, found._id);
      // The exchange rules that target it go before it too, for the same reason.
      await clientPoliciesService.removeTarget(tenant._id, found.uri);
      // Recorded now: were the resource delete to fail, a retry finds no
      // role left and could not record them.
      for (const role of roles) {
        await ctx.audit("role.delete", {
          type: "role",
          id: role._id.toHexString(),
          tenantId: tenant._id.toHexString(),
        });
      }
    }
    return resourcesService.deleteResource(tenant._id, id);
  });
  for (const scope of scopes) {
    await ctx.audit("scope.delete", target("scope", tenant._id, scope._id));
  }
  for (const type of types) {
    await ctx.audit(
      "detailType.delete",
      target("detailType", tenant._id, type._id),
    );
  }
  if (ObjectId.isValid(id)) {
    await ctx.audit(
      "resource.delete",
      target("resource", tenant._id, new ObjectId(id)),
    );
  }
  return removed;
}
