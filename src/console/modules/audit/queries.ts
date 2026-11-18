import { InvalidCursorError } from "@softistx/mongo";
import type { Resolvers } from "@/generated/console/resolvers";
import { isAuthEventType } from "@/modules/audit/auth-events.model";
import type { ConsoleContext } from "../../context";
import { liveTenant, tenantIdOf } from "../ids";
import { badInput } from "../users/shapes";

const MAX_PAGE = 100;
const MAX_TYPES = 20;

const limitOf = (first: number | null | undefined) =>
  Math.min(Math.max(first ?? 25, 1), MAX_PAGE);

/** A cursor the store refuses is the caller's mistake. */
async function guarded<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw badInput("The cursor is not valid");
    }
    throw error;
  }
}

/** Each distinct id looked up once, whatever the page's size. */
async function resolveEach<T>(
  ids: readonly string[],
  find: (id: string) => Promise<T | null>,
) {
  const distinct = [...new Set(ids)];
  const found = await Promise.all(distinct.map((id) => find(id)));
  return new Map(distinct.map((id, index) => [id, found[index] ?? null]));
}

interface Named {
  name?: string | undefined;
  email: string;
}

const actorOf = (
  kind: "user" | "client" | "system",
  id: string,
  people: Map<string, Named | null>,
) => {
  const person = kind === "user" ? (people.get(id) ?? null) : null;
  return {
    kind,
    id,
    name: person?.name ?? null,
    email: person?.email ?? null,
  };
};

const adminPage = async (
  ctx: ConsoleContext,
  scope: Parameters<ConsoleContext["activity"]["admin"]["page"]>[0],
  args: {
    filter?: {
      from?: Date | null;
      to?: Date | null;
      action?: string | null;
      actor?: string | null;
    } | null;
    first?: number | null;
    after?: string | null;
  },
) => {
  const page = await guarded(() =>
    ctx.activity.admin.page(scope, args.filter ?? {}, {
      after: args.after ?? null,
      limit: limitOf(args.first),
    }),
  );
  const admins = await resolveEach(
    page.items.map((event) => event.actor),
    (id) => ctx.directory.findUser(id),
  );
  return {
    items: page.items.map((event) => ({
      id: event._id.toHexString(),
      action: event.action,
      actor: actorOf("user", event.actor, admins),
      target: event.target,
      tenantId: event.tenantId?.toHexString() ?? null,
      at: event.at,
      requestId: event.requestId,
    })),
    nextCursor: page.nextCursor,
    totalCount: page.totalCount,
  };
};

export const auditQueries: NonNullable<Resolvers["Query"]> = {
  adminEvents: async (_, { tenantId: given, ...args }, ctx) => {
    const tenantId = tenantIdOf(given);
    await liveTenant(ctx.directory, tenantId);
    return adminPage(ctx, { tenantId }, args);
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
      items: page.items.map((event) => ({
        id: event._id.toHexString(),
        type: event.type,
        at: event.at,
        outcome: event.outcome,
        reason: event.reason,
        method: event.method,
        actor: actorOf(event.actor.kind, event.actor.id, people),
        userId: event.userId,
        clientId: event.clientId,
        ip: event.ip,
        userAgent: event.userAgent,
        requestId: event.requestId,
      })),
      nextCursor: page.nextCursor,
      totalCount: page.totalCount,
    };
  },
};
