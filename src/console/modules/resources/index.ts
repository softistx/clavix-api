import { ObjectId } from "mongodb";
import { catalog } from "@/config/resources";
import { rolesService } from "@/config/roles";
import type { Resolvers } from "@/generated/console/resolvers";
import type {
  StoredResourceDoc,
  StoredScopeDoc,
} from "@/modules/resources/catalog";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import { activeTenant, refusing, tenantArg } from "../catalog-support";
import { keepConsoleResource } from "../reserved";

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

export const resourcesAudits: Audits = {
  "Mutation.createResource": "resource.create",
  "Mutation.updateResource": "resource.update",
  "Mutation.deleteResource": "resource.delete",
  "Mutation.createScope": "scope.create",
  "Mutation.updateScope": "scope.update",
  "Mutation.deleteScope": "scope.delete",
};

// What an admin event names: the document's id and its tenant.
const target = (
  type: "resource" | "scope",
  tenantId: ObjectId,
  id: ObjectId,
) => ({
  type,
  id: id.toHexString(),
  tenantId: tenantId.toHexString(),
});

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
      await ctx.audit(
        "resource.create",
        target("resource", tenant._id, created._id),
      );
      return resourceShape(created, []);
    },
    updateResource: async (_, { tenantId, id, input }, ctx) => {
      const { _id } = await activeTenant(ctx, tenantId);
      const updated = await refusing(() =>
        catalog.updateResource(_id, id, { name: input.name }),
      );
      await ctx.audit("resource.update", target("resource", _id, updated._id));
      return resourceShape(
        updated,
        await catalog.listScopes(_id, { resourceId: updated._id }),
      );
    },
    deleteResource: async (_, { tenantId, id }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      let scopes: StoredScopeDoc[] = [];
      let roles: { _id: ObjectId }[] = [];
      const removed = await refusing(async () => {
        const found = await catalog.findResource(tenant._id, id);
        keepConsoleResource(tenant, found);
        if (found !== undefined) {
          scopes = await catalog.listScopes(tenant._id, {
            resourceId: found._id,
          });
          // The roles scoped to it go first: were the resource gone before them
          // a retry would find nothing to clean up.
          roles = await rolesService.deleteForResource(tenant._id, found._id);
        }
        return catalog.deleteResource(tenant._id, id);
      });
      // Its scopes go with it: one event each, then the resource's, which is
      // recorded on a repeat too (it may be the event the first run missed).
      for (const scope of scopes) {
        await ctx.audit("scope.delete", target("scope", tenant._id, scope._id));
      }
      for (const role of roles) {
        await ctx.audit("role.delete", {
          type: "role",
          id: role._id.toHexString(),
          tenantId: tenant._id.toHexString(),
        });
      }
      if (ObjectId.isValid(id)) {
        await ctx.audit(
          "resource.delete",
          target("resource", tenant._id, new ObjectId(id)),
        );
      }
      return removed;
    },
    createScope: async (_, { tenantId, input }, ctx) => {
      const { _id } = await activeTenant(ctx, tenantId);
      const created = await refusing(() =>
        catalog.createScope(_id, {
          name: input.name,
          description: {
            fr: input.description?.fr ?? undefined,
            en: input.description?.en ?? undefined,
          },
          resourceId: input.resourceId ?? null,
          claims: input.claims ?? undefined,
        }),
      );
      await ctx.audit("scope.create", target("scope", _id, created._id));
      return scopeShape(created);
    },
    updateScope: async (_, { tenantId, id, input }, ctx) => {
      const { _id } = await activeTenant(ctx, tenantId);
      const updated = await refusing(() =>
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
      );
      await ctx.audit("scope.update", target("scope", _id, updated._id));
      return scopeShape(updated);
    },
    deleteScope: async (_, { tenantId, id }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const removed = await refusing(async () => {
        const scope = await catalog.findScope(tenant._id, id);
        if (scope !== undefined && scope.resourceId !== null) {
          keepConsoleResource(
            tenant,
            await catalog.findResource(
              tenant._id,
              scope.resourceId.toHexString(),
            ),
          );
        }
        return catalog.deleteScope(tenant._id, id);
      });
      if (ObjectId.isValid(id)) {
        await ctx.audit(
          "scope.delete",
          target("scope", tenant._id, new ObjectId(id)),
        );
      }
      return removed;
    },
  },
};
