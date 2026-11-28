import { oncePerRequest } from "@softistx/alxia-graphql";
import DataLoader from "dataloader";
import { ObjectId } from "mongodb";
import { resourcesService } from "@/config/resources";
import type { ConsoleContext } from "@/console/context";
import { scopeShape } from "@/modules/resources";
import { permissionsOf } from "./roles.utils";

/**
 * `TenantRole.permissions` of one tenant, batched per request: the scopes of
 * every role of a page are read in one query, not once per role. A scope id
 * that no longer names a scope is left out.
 */
export const scopeLoader = (ctx: ConsoleContext, tenantId: string) =>
  oncePerRequest(
    ctx,
    `roles.scopes:${tenantId}`,
    () =>
      new DataLoader(async (scopeIds: readonly string[]) => {
        const found = await resourcesService.findScopes(
          new ObjectId(tenantId),
          scopeIds.map((scopeId) => new ObjectId(scopeId)),
        );
        const byId = new Map(
          found.map((scope) => [scope._id.toHexString(), scopeShape(scope)]),
        );
        return scopeIds.map((scopeId) => byId.get(scopeId) ?? null);
      }),
  );

/** The scopes a role holds, by name. */
export async function permissionsOfRole(
  ctx: ConsoleContext,
  role: { tenantId: string; permissionIds: readonly string[] },
) {
  const loaded = await scopeLoader(ctx, role.tenantId).loadMany([
    ...role.permissionIds,
  ]);
  return permissionsOf(loaded);
}
