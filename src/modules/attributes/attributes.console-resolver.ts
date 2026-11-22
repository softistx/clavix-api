import { freshPerMutation } from "@softistx/alxia-graphql";
import {
  attributesService,
  attributeValuesService,
  roleAttributesService,
} from "@/config/attributes";
import { refusing } from "@/console/modules/catalog-support";
import { idArg } from "@/console/modules/ids";
import { userKey } from "@/console/modules/user-key";
import type { Resolvers } from "@/generated/console/resolvers";
import {
  changesOf,
  createInput,
  sectionOf,
  shapeOne,
  shapes,
  tenantOf,
  updateInput,
} from "./attributes.console-support";
import { completeLoader, sectionsLoader } from "./attributes.data-loader";
import { refuseCommon } from "./attributes.refusals";
import { roleTarget, target } from "./utils";

export {
  attributesAudits,
  attributesGuards,
} from "./attributes.console-guards";

export const attributes: Resolvers = freshPerMutation({
  TenantUser: {
    // Batched for a page of users, read only when the field is selected.
    attributes: (user, _, ctx) =>
      sectionsLoader(ctx, user.tenantId).load(user.id),
    attributesComplete: (user, _, ctx) =>
      completeLoader(ctx, user.tenantId).load(user.id),
  },
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
    setUserAttributeValues: async (
      _,
      { tenantId, userId, section, values },
      ctx,
    ) => {
      const tenant = await tenantOf(ctx, tenantId);
      idArg(userId, "userId");
      const roleId = section.roleId ?? null;
      if (roleId !== null) idArg(roleId, "section.roleId");
      // The user is checked under its lock, so a concurrent `deleteUser`
      // (which sweeps the values under the same key) leaves no orphan value.
      // A role section's role is checked held under it too, and its links
      // read there: an `unassignRole` or `deleteRole` that wins the race
      // leaves the value stored but hidden, as if the save had come first.
      const known = await ctx.exclusive(
        userKey(tenant.hex, userId),
        async () => {
          if ((await ctx.users.find(tenant.hex, userId)) === null) return false;
          await refusing(async () =>
            attributeValuesService.save(
              tenant.id,
              userId,
              changesOf(values),
              { kind: "admin", id: ctx.principal.userId },
              true,
              await sectionOf(tenant.id, userId, roleId),
            ),
          );
          return true;
        },
      );
      if (!known) return refuseCommon("NOT_FOUND", "No such user");
      await ctx.audit("user.setAttributes", {
        type: "user",
        id: userId,
        tenantId: tenant.hex,
      });
      return sectionsLoader(ctx, tenant.hex).load(userId);
    },
    assignRoleAttribute: async (
      _,
      { tenantId, roleId, attributeId, required },
      ctx,
    ) => {
      const tenant = await tenantOf(ctx, tenantId);
      const linked = await refusing(() =>
        roleAttributesService.assign(
          tenant.id,
          idArg(roleId, "roleId"),
          idArg(attributeId, "attributeId"),
          required ?? false,
        ),
      );
      await ctx.audit("roleAttribute.assign", roleTarget(roleId, tenant.hex));
      await ctx.audit("roleAttribute.assign", target(attributeId, tenant.hex));
      return shapeOne(tenant.id, linked);
    },
    updateRoleAttribute: async (
      _,
      { tenantId, roleId, attributeId, required },
      ctx,
    ) => {
      const tenant = await tenantOf(ctx, tenantId);
      const linked = await refusing(() =>
        roleAttributesService.update(
          tenant.id,
          idArg(roleId, "roleId"),
          idArg(attributeId, "attributeId"),
          required,
        ),
      );
      await ctx.audit("roleAttribute.update", roleTarget(roleId, tenant.hex));
      await ctx.audit("roleAttribute.update", target(attributeId, tenant.hex));
      return shapeOne(tenant.id, linked);
    },
    unassignRoleAttribute: async (
      _,
      { tenantId, roleId, attributeId },
      ctx,
    ) => {
      const tenant = await tenantOf(ctx, tenantId);
      const removed = await roleAttributesService.unassign(
        tenant.id,
        idArg(roleId, "roleId"),
        idArg(attributeId, "attributeId"),
      );
      // Recorded on a repeat too (it may be the event the first run missed).
      await ctx.audit("roleAttribute.unassign", roleTarget(roleId, tenant.hex));
      await ctx.audit(
        "roleAttribute.unassign",
        target(attributeId, tenant.hex),
      );
      return removed;
    },
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
});
