import { catalog } from "@/config/resources";
import type { Resolvers } from "@/generated/console/resolvers";
import type {
  StoredResourceDoc,
  StoredScopeDoc,
} from "@/modules/resources/catalog";
import { type Guards, onTenant } from "../../guard";
import { activeTenant, refusing, tenantArg } from "../catalog-support";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

export const resourcesGuards: Guards = {
  "Query.resources": view,
  "Query.resource": view,
  "Query.scopes": view,
  "Mutation.createResource": edit,
  "Mutation.updateResource": edit,
  "Mutation.deleteResource": edit,
  "Mutation.createScope": edit,
  "Mutation.updateScope": edit,
  "Mutation.deleteScope": edit,
};

const scopeShape = (scope: StoredScopeDoc) => ({
  id: scope._id.toHexString(),
  name: scope.name,
  description: scope.description,
  resourceId: scope.resourceId?.toHexString() ?? null,
  claims: scope.claims,
});

const resourceShape = (
  resource: StoredResourceDoc,
  scopes: StoredScopeDoc[],
) => ({
  id: resource._id.toHexString(),
  uri: resource.uri,
  name: resource.name,
  scopes: scopes
    .filter((scope) => scope.resourceId?.equals(resource._id))
    .map(scopeShape),
  createdAt: resource.createdAt,
});

export const resources: Resolvers = {
  Query: {
    resources: async (_, { tenantId }, ctx) => {
      const { _id } = await activeTenant(ctx, tenantId);
      const [found, scopes] = await Promise.all([
        catalog.listResources(_id),
        catalog.listScopes(_id),
      ]);
      return found.map((resource) => resourceShape(resource, scopes));
    },
    resource: async (_, { tenantId, id }, ctx) => {
      const { _id } = await activeTenant(ctx, tenantId);
      const found = await catalog.findResource(_id, id);
      return found === undefined
        ? null
        : resourceShape(
            found,
            await catalog.listScopes(_id, { resourceId: found._id }),
          );
    },
    scopes: async (_, { tenantId, resourceId }, ctx) => {
      const { _id } = await activeTenant(ctx, tenantId);
      if (resourceId === undefined || resourceId === null) {
        return (await catalog.listScopes(_id)).map(scopeShape);
      }
      const owner = await catalog.findResource(_id, resourceId);
      return owner === undefined
        ? []
        : (await catalog.listScopes(_id, { resourceId: owner._id })).map(
            scopeShape,
          );
    },
  },
  Mutation: {
    createResource: async (_, { tenantId, input }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const created = await refusing(() =>
        catalog.createResource(tenant._id, tenant.slug, {
          uri: input.uri,
          name: input.name ?? undefined,
        }),
      );
      return resourceShape(created, []);
    },
    updateResource: async (_, { tenantId, id, input }, ctx) => {
      const { _id } = await activeTenant(ctx, tenantId);
      const updated = await refusing(() =>
        catalog.updateResource(_id, id, { name: input.name }),
      );
      return resourceShape(
        updated,
        await catalog.listScopes(_id, { resourceId: updated._id }),
      );
    },
    deleteResource: async (_, { tenantId, id }, ctx) =>
      catalog.deleteResource((await activeTenant(ctx, tenantId))._id, id),
    createScope: async (_, { tenantId, input }, ctx) => {
      const { _id } = await activeTenant(ctx, tenantId);
      return scopeShape(
        await refusing(() =>
          catalog.createScope(_id, {
            name: input.name,
            description: {
              fr: input.description?.fr ?? undefined,
              en: input.description?.en ?? undefined,
            },
            resourceId: input.resourceId ?? null,
            claims: input.claims ?? undefined,
          }),
        ),
      );
    },
    updateScope: async (_, { tenantId, id, input }, ctx) => {
      const { _id } = await activeTenant(ctx, tenantId);
      return scopeShape(
        await refusing(() =>
          catalog.updateScope(_id, id, {
            description:
              input.description === undefined || input.description === null
                ? undefined
                : {
                    fr: input.description.fr ?? undefined,
                    en: input.description.en ?? undefined,
                  },
            claims: input.claims ?? undefined,
          }),
        ),
      );
    },
    deleteScope: async (_, { tenantId, id }, ctx) =>
      catalog.deleteScope((await activeTenant(ctx, tenantId))._id, id),
  },
};
