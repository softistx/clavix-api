import { JanusError } from "@softistx/janus";
import type { Resolvers } from "@/generated/console/resolvers";
import { liveTenant, tenantIdOf } from "../ids";
import { badInput, grantShape, shape } from "./shapes";

const MAX_PAGE = 100;
const MAX_PREFIX = 254;

export const userQueries: NonNullable<Resolvers["Query"]> = {
  users: async (
    _,
    { tenantId: given, after, first, email, emailPrefix },
    ctx,
  ) => {
    const tenantId = tenantIdOf(given);
    const prefix = emailPrefix?.trim() ?? "";
    if (email !== null && email !== undefined && prefix !== "") {
      throw badInput("Give either email or emailPrefix, not both");
    }
    if ([...prefix].length > MAX_PREFIX) {
      throw badInput("The prefix is too long");
    }
    await liveTenant(ctx.directory, tenantId);
    if (email !== null && email !== undefined) {
      const found = await ctx.users.findByEmail(tenantId, email);
      return {
        items: found === null ? [] : [shape(found)],
        nextCursor: null,
        totalCount: found === null ? 0 : 1,
      };
    }
    const filter = prefix === "" ? {} : { emailPrefix: prefix };
    try {
      const page = await ctx.users.list(tenantId, {
        after: after ?? null,
        limit: Math.min(Math.max(first ?? 25, 1), MAX_PAGE),
        ...filter,
      });
      return {
        items: page.items.map(shape),
        nextCursor: page.nextCursor,
        totalCount: await ctx.users.count(tenantId, filter),
      };
    } catch (error) {
      if (error instanceof JanusError && error.code === "INVALID_CURSOR") {
        throw badInput("The cursor is not valid");
      }
      throw error;
    }
  },
  user: async (_, { tenantId: given, id }, ctx) => {
    const tenantId = tenantIdOf(given);
    await liveTenant(ctx.directory, tenantId);
    const found = await ctx.users.find(tenantId, id);
    return found === null ? null : shape(found);
  },
  userInvitations: async (_, { tenantId: given }, ctx) => {
    const tenantId = tenantIdOf(given);
    await liveTenant(ctx.directory, tenantId);
    return ctx.users.invitations(tenantId);
  },
  userGrants: async (_, { tenantId: given, userId }, ctx) => {
    const tenantId = tenantIdOf(given);
    await liveTenant(ctx.directory, tenantId);
    return (await ctx.users.grants(tenantId, userId)).map(grantShape);
  },
};
