import { resourcesService } from "@/config/resources";
import { catalogTenant } from "@/console/modules/catalog-support";
import type { Resolvers } from "@/generated/console/resolvers";
import { showResource, showResources } from "./resources.console-support";
import { scopeShape } from "./resources.utils";

export const resourceQueries: NonNullable<Resolvers["Query"]> = {
  resources: async (_, { tenantId }, ctx) => {
    return showResources(await catalogTenant(ctx, tenantId));
  },
  resource: async (_, { tenantId, id }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const found = await resourcesService.findResource(tenant._id, id);
    return found === undefined ? null : showResource(tenant, found);
  },
  scopes: async (_, { tenantId, resourceId }, ctx) => {
    const { _id } = await catalogTenant(ctx, tenantId);
    if (resourceId === undefined || resourceId === null) {
      return (await resourcesService.listScopes(_id)).map(scopeShape);
    }
    const owner = await resourcesService.findResource(_id, resourceId);
    return owner === undefined
      ? []
      : (await resourcesService.listScopes(_id, { resourceId: owner._id })).map(
          scopeShape,
        );
  },
};
