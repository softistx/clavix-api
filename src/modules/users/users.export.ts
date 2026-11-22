import { ObjectId } from "mongodb";
import { attributeValuesService } from "@/config/attributes";
import { rolesService } from "@/config/roles";
import type { ConsoleContext } from "@/console/context";
import { exportedView } from "@/modules/attributes";
import { fail } from "@/shared/errors";
import { grantShape, shape } from "./users.utils";

/**
 * Everything the console holds about one user (a data-access request): the
 * profile, the attribute values (hidden ones flagged), the roles, the grants and
 * the sessions. A user the tenant does not know is NOT_FOUND.
 */
export async function userDataExport(
  ctx: ConsoleContext,
  tenantId: string,
  userId: string,
) {
  const found = await ctx.users.find(tenantId, userId);
  if (found === null) throw fail("NOT_FOUND", "No such user", { status: 404 });
  const tenant = new ObjectId(tenantId);
  const [values, roles, grants, sessions] = await Promise.all([
    attributeValuesService.personalDataOf(tenant, userId),
    rolesService.personalDataOf(tenant, userId),
    ctx.users.grants(tenantId, userId),
    ctx.users.sessions(tenantId, userId),
  ]);
  return {
    exportedAt: new Date(),
    profile: shape(found, tenantId),
    attributes: values.map(exportedView),
    roles,
    grants: grants.map(grantShape),
    sessions: sessions.map((session) => ({
      ...session,
      device: session.device ?? null,
      lastUsedAt: session.lastUsedAt ?? null,
    })),
  };
}
