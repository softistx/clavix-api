import { rolesService } from "@/config/roles";
import { refusing } from "@/console/modules/catalog-support";
import { idArg } from "@/console/modules/ids";
import { userKey } from "@/console/modules/user-key";
import type { Resolvers } from "@/generated/console/resolvers";
import { fail } from "@/shared/errors";
import {
  memberPage,
  shapeOne,
  shapes,
  tenantOf,
} from "./roles.console-support";
import { target } from "./roles.utils";

export { rolesAudits, rolesGuards } from "./roles.console-guards";

export const roles: Resolvers = {
  Query: {
    roles: async (_, { tenantId, resourceId }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      return shapes(
        tenant.id,
        await rolesService.list(tenant.id, {
          resourceId: resourceId ?? undefined,
        }),
      );
    },
    role: async (_, { tenantId, id }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      const found = await rolesService.find(tenant.id, id);
      return found === undefined ? null : shapeOne(tenant.id, found);
    },
    roleMembers: async (_, { tenantId, roleId, after, first }, ctx) =>
      memberPage(ctx, await tenantOf(ctx, tenantId), roleId, { after, first }),
    userRoles: async (_, { tenantId, userId }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      return shapes(
        tenant.id,
        await rolesService.rolesOfUser(tenant.id, userId),
      );
    },
  },
  Mutation: {
    createRole: async (_, { tenantId, input }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      const created = await refusing(() =>
        rolesService.create(tenant.id, {
          name: input.name,
          description: input.description ?? undefined,
          resourceId: input.resourceId ?? null,
        }),
      );
      await ctx.audit(
        "role.create",
        target("role", created._id.toHexString(), tenant.hex),
      );
      return shapeOne(tenant.id, created);
    },
    updateRole: async (_, { tenantId, id, input }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      const updated = await refusing(() =>
        rolesService.update(tenant.id, id, {
          name: input.name ?? undefined,
          description: input.description ?? undefined,
        }),
      );
      await ctx.audit(
        "role.update",
        target("role", updated._id.toHexString(), tenant.hex),
      );
      return shapeOne(tenant.id, updated);
    },
    deleteRole: async (_, { tenantId, id }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      idArg(id, "id");
      await refusing(() => rolesService.delete(tenant.id, id));
      // Recorded on a repeat too (it may be the event the first run missed).
      await ctx.audit("role.delete", target("role", id, tenant.hex));
      return true;
    },
    assignRole: async (_, { tenantId, roleId, userId }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      idArg(roleId, "roleId");
      idArg(userId, "userId");
      // Only a user of this tenant's pool can hold a role. Alone with a
      // `deleteUser` of the same user, so the user cannot go (and its
      // assignments be swept) between the check and the write.
      await ctx.exclusive(userKey(tenant.hex, userId), async () => {
        if ((await ctx.users.find(tenant.hex, userId)) === null) {
          throw fail("NOT_FOUND", "No such user", { status: 404 });
        }
        await refusing(() => rolesService.assign(tenant.id, roleId, userId));
      });
      await ctx.audit("role.assign", target("role", roleId, tenant.hex));
      await ctx.audit("role.assign", target("user", userId, tenant.hex));
      return true;
    },
    unassignRole: async (_, { tenantId, roleId, userId }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      idArg(roleId, "roleId");
      idArg(userId, "userId");
      const removed = await rolesService.unassign(tenant.id, roleId, userId);
      await ctx.audit("role.unassign", target("role", roleId, tenant.hex));
      await ctx.audit("role.unassign", target("user", userId, tenant.hex));
      return removed;
    },
  },
};
