import { liveTenant, tenantIdOf } from "@/console/modules/ids";
import type { Resolvers } from "@/generated/console/resolvers";
import { badInput } from "@/modules/users/users.errors";
import {
  adminEventOf,
  adminPage,
  authEventOf,
  guarded,
  limitOf,
  resolveEach,
} from "./audit.console-support";
import { isAuthEventType } from "./audit.model";

const MAX_TYPES = 20;

export const auditQueries: NonNullable<Resolvers["Query"]> = {
  adminEvents: async (_, { tenantId: given, ...args }, ctx) => {
    const tenantId = tenantIdOf(given);
    await liveTenant(ctx.directory, tenantId);
    return adminPage(ctx, { tenantId }, args);
  },
  adminEvent: async (_, { tenantId: given, id }, ctx) => {
    const tenantId = tenantIdOf(given);
    await liveTenant(ctx.directory, tenantId);
    const event = await ctx.activity.admin.find({ tenantId }, id);
    if (event === null) return null;
    const admins = await resolveEach([event.actor], (actor) =>
      ctx.directory.findUser(actor),
    );
    return adminEventOf(event, admins);
  },
  platformAdminEvent: async (_, { id }, ctx) => {
    const event = await ctx.activity.admin.find({ all: true }, id);
    if (event === null) return null;
    const admins = await resolveEach([event.actor], (actor) =>
      ctx.directory.findUser(actor),
    );
    return adminEventOf(event, admins);
  },
  authEvent: async (_, { tenantId: given, id }, ctx) => {
    const tenantId = tenantIdOf(given);
    await liveTenant(ctx.directory, tenantId);
    const event = await ctx.activity.auth.find(tenantId, id);
    if (event === null) return null;
    const people = await resolveEach(
      event.actor.kind === "user" ? [event.actor.id] : [],
      (actor) => ctx.users.find(tenantId, actor),
    );
    return authEventOf(event, people);
  },
  platformAdminEvents: (_, args, ctx) => adminPage(ctx, { all: true }, args),
  authEvents: async (_, { tenantId: given, filter, first, after }, ctx) => {
    const tenantId = tenantIdOf(given);
    const types = filter?.types ?? [];
    if (types.length > MAX_TYPES) throw badInput("Too many types");
    const unknown = types.find((type) => !isAuthEventType(type));
    if (unknown !== undefined) {
      throw badInput(`${unknown} is not an event type`);
    }
    await liveTenant(ctx.directory, tenantId);
    const page = await guarded(() =>
      ctx.activity.auth.page(
        tenantId,
        {
          from: filter?.from,
          to: filter?.to,
          types: types.filter(isAuthEventType),
          userId: filter?.userId,
          clientId: filter?.clientId,
          outcome: filter?.outcome,
        },
        { after: after ?? null, limit: limitOf(first) },
      ),
    );
    const people = await resolveEach(
      page.items
        .filter((event) => event.actor.kind === "user")
        .map((event) => event.actor.id),
      (id) => ctx.users.find(tenantId, id),
    );
    return {
      items: page.items.map((event) => authEventOf(event, people)),
      nextCursor: page.nextCursor,
      totalCount: page.totalCount,
    };
  },
};
