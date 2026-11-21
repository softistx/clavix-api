import { denial } from "@softistx/janus-graphql";
import { InvalidCursorError } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { rolesService } from "@/config/roles";
import type { Resolvers } from "@/generated/console/resolvers";
import type { RoleDoc } from "@/modules/roles/roles.service";
import { fail } from "@/shared/errors";
import type { Audits } from "../../audit";
import type { ConsoleContext } from "../../context";
import { type Guards, onTenant } from "../../guard";
import { refusing } from "../catalog-support";
import { idArg, liveTenant, tenantArg, tenantIdOf } from "../ids";
import { userKey } from "../user-key";
import { shape as userShape } from "../users/shapes";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

// Reading roles is `view`; changing them or their holders is `edit`.
export const rolesGuards: Guards = {
  "Query.roles": view,
  "Query.role": view,
  "Query.roleMembers": view,
  "Query.userRoles": view,
  "Mutation.createRole": edit,
  "Mutation.updateRole": edit,
  "Mutation.deleteRole": edit,
  "Mutation.assignRole": edit,
  "Mutation.unassignRole": edit,
};

// One event per mutation, once its change is stored; a repeat records again
// (the retry of a call whose record failed). `assignRole` and `unassignRole`
// record two, one for the role and one for the user. Ids only.
export const rolesAudits: Audits = {
  "Mutation.createRole": "role.create",
  "Mutation.updateRole": "role.update",
  "Mutation.deleteRole": "role.delete",
  "Mutation.assignRole": "role.assign",
  "Mutation.unassignRole": "role.unassign",
};

const target = (type: "role" | "user", id: string, tenantId: string) => ({
  type,
  id,
  tenantId,
});

const MAX_PAGE = 100;

const shape = (role: RoleDoc, memberCount: number) => ({
  id: role._id.toHexString(),
  name: role.name,
  description: role.description === "" ? null : role.description,
  resourceId: role.resourceId?.toHexString() ?? null,
  managed: role.managed,
  memberCount,
  createdAt: role.createdAt,
});

/** Several roles at once: their member counts come from one query. */
async function shapes(tenantId: ObjectId, found: RoleDoc[]) {
  const counts = await rolesService.memberCounts(tenantId, found);
  return found.map((role) =>
    shape(role, counts.get(role._id.toHexString()) ?? 0),
  );
}

const shapeOne = async (tenantId: ObjectId, role: RoleDoc) =>
  shape(role, await rolesService.memberCount(tenantId, role));

/** The tenant of the call (suspended included; the guard refuses its writes): the id as an ObjectId. */
async function tenantOf(ctx: ConsoleContext, given: string) {
  const hex = tenantIdOf(given);
  await liveTenant(ctx.directory, hex);
  return { hex, id: new ObjectId(hex) };
}

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
    roleMembers: async (_, { tenantId, roleId, after, first }, ctx) => {
      const tenant = await tenantOf(ctx, tenantId);
      let page: Awaited<ReturnType<typeof rolesService.members>>;
      try {
        page = await rolesService.members(tenant.id, roleId, {
          after: after ?? null,
          limit: Math.min(Math.max(first ?? 25, 1), MAX_PAGE),
        });
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          throw fail("BAD_USER_INPUT", "The cursor is not valid", {
            status: 400,
          });
        }
        throw error;
      }
      const users = await Promise.all(
        page.items.map((held) => ctx.users.find(tenant.hex, held.userId)),
      );
      const items = page.items.flatMap((held, index) => {
        const user = users[index];
        return user === null || user === undefined
          ? []
          : [
              {
                user: userShape(user, tenant.hex),
                assignedAt: held.createdAt,
              },
            ];
      });
      return {
        items,
        nextCursor: page.nextCursor,
        totalCount: await rolesService.membersCount(tenant.id, roleId),
      };
    },
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
          throw denial("NOT_FOUND", "No such user");
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
