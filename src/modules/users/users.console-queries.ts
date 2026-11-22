import { JanusError } from "@softistx/janus";
import { idArg, liveTenant, pageSize, tenantIdOf } from "@/console/modules/ids";
import type { Resolvers } from "@/generated/console/resolvers";
import { badInput } from "@/shared/errors";
import { filteredUsers } from "./users.console-filter";
import { userDataExport } from "./users.export";
import { grantShape, shape, target } from "./users.utils";

const MAX_PREFIX = 254;
/** The suggestions a lookup returns at most (10 by default). */
const MAX_LOOKUP = 20;

export const userQueries: NonNullable<Resolvers["Query"]> = {
  users: async (
    _,
    { tenantId: given, after, first, email, emailPrefix, roleId, attributes },
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
    const narrowed = (attributes?.length ?? 0) > 0 || (roleId ?? null) !== null;
    if (narrowed && email !== null && email !== undefined) {
      throw badInput(
        "Give either email or role and attribute filters, not both",
      );
    }
    if (narrowed) {
      return filteredUsers(
        ctx,
        tenantId,
        { roleId, attributes },
        { prefix, after, first },
      );
    }
    if (email !== null && email !== undefined) {
      const found = await ctx.users.findByEmail(tenantId, email);
      return {
        items: found === null ? [] : [shape(found, tenantId)],
        nextCursor: null,
        totalCount: found === null ? 0 : 1,
      };
    }
    const filter = prefix === "" ? {} : { emailPrefix: prefix };
    try {
      const page = await ctx.users.list(tenantId, {
        after: after ?? null,
        limit: pageSize(first),
        ...filter,
      });
      return {
        items: page.items.map((item) => shape(item, tenantId)),
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
  userLookup: async (_, { tenantId: given, query, first }, ctx) => {
    const tenantId = tenantIdOf(given);
    const text = query.trim();
    if ([...text].length > MAX_PREFIX) {
      throw badInput("The query is too long");
    }
    await liveTenant(ctx.directory, tenantId);
    if (text === "") return [];
    const found = await ctx.users.lookup(
      tenantId,
      text,
      pageSize(first, 10, MAX_LOOKUP),
    );
    return found.map(({ id, email, name }) => ({
      id,
      email,
      name: name ?? null,
    }));
  },
  user: async (_, { tenantId: given, id }, ctx) => {
    const tenantId = tenantIdOf(given);
    await liveTenant(ctx.directory, tenantId);
    const found = await ctx.users.find(tenantId, id);
    return found === null ? null : shape(found, tenantId);
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
  userSessions: async (_, { tenantId: given, userId }, ctx) => {
    const tenantId = tenantIdOf(given);
    await liveTenant(ctx.directory, tenantId);
    return (await ctx.users.sessions(tenantId, userId)).map((session) => ({
      ...session,
      device: session.device ?? null,
      lastUsedAt: session.lastUsedAt ?? null,
    }));
  },
  userDataExport: async (_, { tenantId: given, userId }, ctx) => {
    const tenantId = tenantIdOf(given);
    idArg(userId, "userId");
    await liveTenant(ctx.directory, tenantId);
    const exported = await userDataExport(ctx, tenantId, userId);
    // A query is outside `Audits` (mutations only), and this read exposes
    // personal data: it is recorded here, once the export is built.
    await ctx.audit("user.export", target("user", userId, tenantId));
    return exported;
  },
};
