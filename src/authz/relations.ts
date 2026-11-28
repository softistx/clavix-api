import type { RelationChecker } from "@softistx/limix";
import type { ConsoleContext } from "@/console/context";
import { callerProved, permitted, targetAhead } from "@/console/guard";
import type { Permission } from "@/console/model";
import { PERMISSIONS } from "@/console/model";
import { isOneOf } from "@/shared/values";

/**
 * The caller's right on a tenant, as the guards decide it: a write on Clavix's
 * own tenant is the platform's (`permitted`), a read is the tenant's.
 */
const holds = async (
  ctx: ConsoleContext,
  permission: Permission,
  tenantId: string,
) =>
  permission === "view"
    ? ctx.can(permission, tenantId)
    : permitted(ctx, permission, tenantId, await targetAhead(ctx, tenantId));

/**
 * The relations port of the console: a rung `{relation: "edit", type:
 * "tenant"}` is `ctx.can("edit", tenantId)`, the console's own ReBAC check
 * (janus `permissions`, for the token's user). Ids are lowercased as the
 * guards do (`tenantArg`); another relation or object type is refused.
 *
 * limix-janus's `janusRelations` is not used: it needs the janus `Access`,
 * which `createAccess` keeps private behind the console's `Access` wrapper.
 */
export const consoleRelations = (ctx: ConsoleContext): RelationChecker => ({
  check: async (queries) => {
    // An unproved e-mail is answered first by the field guard (EMAIL_UNVERIFIED, ADR-0041).
    if (!(await callerProved(ctx))) return queries.map(() => true);
    return Promise.all(
      queries.map(({ relation, object }) =>
        object.type === "tenant" && isOneOf(PERMISSIONS, relation)
          ? holds(ctx, relation, object.id.toLowerCase())
          : Promise.resolve(false),
      ),
    );
  },
});
