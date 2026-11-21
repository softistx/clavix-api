import { InvalidCursorError } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { rolesService } from "@/config/roles";
import type { ConsoleContext } from "@/console/context";
import { liveTenant, pageSize, tenantIdOf } from "@/console/modules/ids";
import { fail } from "@/shared/errors";
import { userLoader } from "../users/users.data-loader";
import { shape as userShape } from "../users/users.utils";
import type { RoleDoc } from "./roles.types";
import { shape } from "./roles.utils";

/** The tenant of the call (suspended included; the guard refuses its writes): the id as an ObjectId. */
export async function tenantOf(ctx: ConsoleContext, given: string) {
  const hex = tenantIdOf(given);
  await liveTenant(ctx.directory, hex);
  return { hex, id: new ObjectId(hex) };
}

/** Several roles at once: their member counts come from one query. */
export async function shapes(tenantId: ObjectId, found: RoleDoc[]) {
  const counts = await rolesService.memberCounts(tenantId, found);
  return found.map((role) =>
    shape(role, counts.get(role._id.toHexString()) ?? 0),
  );
}

export const shapeOne = async (tenantId: ObjectId, role: RoleDoc) =>
  shape(role, await rolesService.memberCount(tenantId, role));

/** A page of a role's holders, each shown as its pool user; a holder no longer in the pool is left out. */
export async function memberPage(
  ctx: ConsoleContext,
  tenant: { hex: string; id: ObjectId },
  roleId: string,
  paging: {
    after?: string | null | undefined;
    first?: number | null | undefined;
  },
) {
  let page: Awaited<ReturnType<typeof rolesService.members>>;
  try {
    page = await rolesService.members(tenant.id, roleId, {
      after: paging.after ?? null,
      limit: pageSize(paging.first),
    });
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw fail("BAD_USER_INPUT", "The cursor is not valid", { status: 400 });
    }
    throw error;
  }
  const loader = userLoader(ctx, tenant.hex);
  const users = await Promise.all(
    page.items.map((held) => loader.load(held.userId)),
  );
  const items = page.items.flatMap((held, index) => {
    const user = users[index];
    return user === null || user === undefined
      ? []
      : [{ user: userShape(user, tenant.hex), assignedAt: held.createdAt }];
  });
  return {
    items,
    nextCursor: page.nextCursor,
    totalCount: await rolesService.membersCount(tenant.id, roleId),
  };
}
