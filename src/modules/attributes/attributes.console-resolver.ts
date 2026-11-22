import { attributesService } from "@/config/attributes";
import { refusing } from "@/console/modules/catalog-support";
import { idArg } from "@/console/modules/ids";
import type { Resolvers } from "@/generated/console/resolvers";
import {
  createInput,
  shapeOne,
  shapes,
  tenantOf,
  updateInput,
} from "./attributes.console-support";
import { target } from "./attributes.utils";

export {
  attributesAudits,
  attributesGuards,
} from "./attributes.console-guards";

export const attributes: Resolvers = {
  Query: {
    userAttributes: async (_, { tenantId, family, archived }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      return shapes(
        tenant.id,
        await attributesService.list(tenant.id, {
          family: family ?? undefined,
          archived: archived ?? false,
        }),
      );
    },
    userAttribute: async (_, { tenantId, id }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      const found = await attributesService.find(tenant.id, id);
      return found === undefined ? null : shapeOne(tenant.id, found);
    },
  },
  Mutation: {
    createUserAttribute: async (_, { tenantId, input }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      const created = await refusing(() =>
        attributesService.create(tenant.id, createInput(input)),
      );
      await ctx.audit(
        "userAttribute.create",
        target(created._id.toHexString(), tenant.hex),
      );
      return shapeOne(tenant.id, created);
    },
    updateUserAttribute: async (_, { tenantId, id, version, input }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      const updated = await refusing(() =>
        attributesService.update(tenant.id, id, version, updateInput(input)),
      );
      await ctx.audit(
        "userAttribute.update",
        target(updated._id.toHexString(), tenant.hex),
      );
      return shapeOne(tenant.id, updated);
    },
    moveUserAttribute: async (_, { tenantId, id, position }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      const moved = await refusing(() =>
        attributesService.move(tenant.id, id, position),
      );
      await ctx.audit(
        "userAttribute.move",
        target(moved._id.toHexString(), tenant.hex),
      );
      return shapeOne(tenant.id, moved);
    },
    archiveUserAttribute: async (_, { tenantId, id }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      const archived = await refusing(() =>
        attributesService.archive(tenant.id, id),
      );
      await ctx.audit(
        "userAttribute.archive",
        target(archived._id.toHexString(), tenant.hex),
      );
      return shapeOne(tenant.id, archived);
    },
    restoreUserAttribute: async (_, { tenantId, id }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      const restored = await refusing(() =>
        attributesService.restore(tenant.id, id),
      );
      await ctx.audit(
        "userAttribute.restore",
        target(restored._id.toHexString(), tenant.hex),
      );
      return shapeOne(tenant.id, restored);
    },
    deleteUserAttribute: async (_, { tenantId, id, confirmKey }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      idArg(id, "id");
      await refusing(() => attributesService.delete(tenant.id, id, confirmKey));
      // Recorded on a repeat too (it may be the event the first run missed).
      await ctx.audit("userAttribute.delete", target(id, tenant.hex));
      return true;
    },
  },
};
