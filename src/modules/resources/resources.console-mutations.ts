import { ObjectId } from "mongodb";
import { resourcesService } from "@/config/resources";
import { tenantDomain } from "@/config/tenancy";
import { catalogTenant, refusing } from "@/console/modules/catalog-support";
import {
  keepConsoleResource,
  refuseMachineConsole,
} from "@/console/modules/reserved";
import type { Resolvers } from "@/generated/console/resolvers";
import {
  documentsOf,
  removeResource,
  showResource,
} from "./resources.console-support";
import {
  detailTypeShape,
  fieldDraft,
  resourceShape,
  scopeShape,
  target,
  valueDraft,
} from "./resources.utils";

export const resourceMutations: NonNullable<Resolvers["Mutation"]> = {
  createResource: async (_, { tenantId, input }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const created = await refusing(() =>
      resourcesService.createResource(tenant._id, tenant.slug, {
        uri: input.uri,
        name: input.name ?? undefined,
      }),
    );
    await ctx.audit(
      "resource.create",
      target("resource", tenant._id, created._id),
    );
    return resourceShape(
      created,
      [],
      [],
      await documentsOf(tenant.slug, tenantDomain)(created, []),
    );
  },
  updateResource: async (_, { tenantId, id, input }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const updated = await refusing(async () => {
      refuseMachineConsole(
        tenant,
        await resourcesService.findResource(tenant._id, id),
        input.allowClientCredentials,
      );
      return resourcesService.updateResource(tenant._id, id, {
        name: input.name ?? undefined,
        allowClientCredentials: input.allowClientCredentials ?? undefined,
      });
    });
    await ctx.audit(
      "resource.update",
      target("resource", tenant._id, updated._id),
    );
    return showResource(tenant, updated);
  },
  deleteResource: async (_, { tenantId, id }, ctx) =>
    removeResource(ctx, await catalogTenant(ctx, tenantId), id),
  createScope: async (_, { tenantId, input }, ctx) => {
    const { _id } = await catalogTenant(ctx, tenantId);
    const created = await refusing(() =>
      resourcesService.createScope(_id, {
        name: input.name,
        description: input.description ?? undefined,
        resourceId: input.resourceId ?? null,
        claims: input.claims ?? undefined,
      }),
    );
    await ctx.audit("scope.create", target("scope", _id, created._id));
    return scopeShape(created);
  },
  updateScope: async (_, { tenantId, id, input }, ctx) => {
    const { _id } = await catalogTenant(ctx, tenantId);
    const before = await resourcesService.findScope(_id, id);
    const updated = await refusing(() =>
      resourcesService.updateScope(_id, id, {
        name: input.name ?? undefined,
        description: input.description ?? undefined,
        claims: input.claims ?? undefined,
      }),
    );
    // A rename is its own event; the audit keeps no values (ADR-0037), so the
    // scope is the target and the old name is not recorded.
    const renamed = before !== undefined && before.name !== updated.name;
    await ctx.audit(
      renamed ? "scope.rename" : "scope.update",
      target("scope", _id, updated._id),
    );
    return scopeShape(updated);
  },
  deleteScope: async (_, { tenantId, id }, ctx) => {
    const tenant = await catalogTenant(ctx, tenantId);
    const removed = await refusing(async () => {
      const scope = await resourcesService.findScope(tenant._id, id);
      if (scope !== undefined && scope.resourceId !== null) {
        keepConsoleResource(
          tenant,
          await resourcesService.findResource(
            tenant._id,
            scope.resourceId.toHexString(),
          ),
        );
      }
      return resourcesService.deleteScope(tenant._id, id);
    });
    if (ObjectId.isValid(id)) {
      await ctx.audit(
        "scope.delete",
        target("scope", tenant._id, new ObjectId(id)),
      );
    }
    return removed;
  },
  createDetailType: async (_, { tenantId, input }, ctx) => {
    const { _id } = await catalogTenant(ctx, tenantId);
    const created = await refusing(() =>
      resourcesService.createDetailType(_id, input.resourceId, {
        type: input.type,
        name: input.name,
        description: input.description ?? undefined,
        fields: input.fields.map(fieldDraft),
        actions: input.actions?.map(valueDraft),
      }),
    );
    await ctx.audit(
      "detailType.create",
      target("detailType", _id, created._id),
    );
    return detailTypeShape(created);
  },
  updateDetailType: async (_, { tenantId, id, input }, ctx) => {
    const { _id } = await catalogTenant(ctx, tenantId);
    const updated = await refusing(() =>
      resourcesService.updateDetailType(_id, id, {
        name: input.name ?? undefined,
        description: input.description ?? undefined,
        fields: input.fields?.map(fieldDraft),
        actions: input.actions?.map(valueDraft),
      }),
    );
    await ctx.audit(
      "detailType.update",
      target("detailType", _id, updated._id),
    );
    return detailTypeShape(updated);
  },
  deleteDetailType: async (_, { tenantId, id }, ctx) => {
    const { _id } = await catalogTenant(ctx, tenantId);
    const removed = await refusing(() =>
      resourcesService.deleteDetailType(_id, id),
    );
    if (ObjectId.isValid(id)) {
      await ctx.audit(
        "detailType.delete",
        target("detailType", _id, new ObjectId(id)),
      );
    }
    return removed;
  },
};
