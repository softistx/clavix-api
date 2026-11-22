import { ObjectId } from "mongodb";
import { userFilterService } from "@/config/attributes";
import type { ConsoleContext } from "@/console/context";
import { pageSize } from "@/console/modules/ids";
import { afterOf, MAX_PREFIX_IDS, type UserFilter } from "@/modules/attributes";
import { badInput } from "@/shared/errors";
import { shape } from "./users.utils";

const BATCH = 100;

/** The ids of the users whose address starts with the prefix, at most `MAX_PREFIX_IDS`. */
async function prefixIds(
  ctx: ConsoleContext,
  tenantId: string,
  emailPrefix: string,
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  do {
    const page = await ctx.users.list(tenantId, {
      after,
      limit: BATCH,
      emailPrefix,
    });
    ids.push(...page.items.map((item) => item.id));
    after = page.nextCursor;
  } while (after !== null && ids.length <= MAX_PREFIX_IDS);
  if (ids.length > MAX_PREFIX_IDS) {
    throw badInput(
      `More than ${MAX_PREFIX_IDS} addresses start with the prefix`,
    );
  }
  return ids;
}

/**
 * One page of the users list narrowed by a role or attribute filter, with
 * `emailPrefix` when given: the matching ids come from the attributes service
 * (its own cursor, in creation order), the users from janus.
 */
export async function filteredUsers(
  ctx: ConsoleContext,
  tenantId: string,
  filter: UserFilter,
  paging: {
    prefix: string;
    after: string | null | undefined;
    first: number | null | undefined;
  },
) {
  const after = paging.after ?? null;
  const last = after === null ? null : afterOf(after);
  if (after !== null && last === null)
    throw badInput("The cursor is not valid");
  const ids =
    paging.prefix === "" ? null : await prefixIds(ctx, tenantId, paging.prefix);
  const page = await userFilterService.page(new ObjectId(tenantId), filter, {
    ids,
    after: last,
    limit: pageSize(paging.first),
  });
  const users = await ctx.users.findMany(tenantId, page.userIds);
  return {
    items: users.flatMap((user) =>
      user === null ? [] : [shape(user, tenantId)],
    ),
    nextCursor: page.nextCursor,
    totalCount: page.totalCount,
  };
}
