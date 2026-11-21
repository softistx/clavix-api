import { InvalidCursorError } from "@softistx/mongo";
import type { StoredAdminEvent } from "@/console/admin-events/reader";
import type { ConsoleContext } from "@/console/context";
import { pageSize } from "@/console/modules/ids";
import { badInput } from "@/shared/errors";
import { unique } from "@/shared/values";
import type { StoredAuthEvent } from "./audit.types";

/** A cursor the store refuses is the caller's mistake. */
export async function guarded<T>(run: () => Promise<T>) {
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
export async function resolveEach<T>(
  ids: readonly string[],
  find: (id: string) => Promise<T | null>,
) {
  const distinct = unique(ids);
  const found = await Promise.all(distinct.map((id) => find(id)));
  return new Map(distinct.map((id, index) => [id, found[index] ?? null]));
}

interface Named {
  name?: string | undefined;
  email: string;
}

export const actorOf = (
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

export const adminEventOf = (
  event: StoredAdminEvent,
  admins: Map<string, Named | null>,
) => ({
  id: event._id.toHexString(),
  action: event.action,
  actor: actorOf("user", event.actor, admins),
  target: event.target,
  tenantId: event.tenantId?.toHexString() ?? null,
  at: event.at,
  requestId: event.requestId,
});

export const authEventOf = (
  event: StoredAuthEvent,
  people: Map<string, Named | null>,
) => ({
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
});

export const adminPage = async (
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
      limit: pageSize(args.first),
    }),
  );
  const admins = await resolveEach(
    page.items.map((event) => event.actor),
    (id) => ctx.directory.findUser(id),
  );
  return {
    items: page.items.map((event) => adminEventOf(event, admins)),
    nextCursor: page.nextCursor,
    totalCount: page.totalCount,
  };
};
