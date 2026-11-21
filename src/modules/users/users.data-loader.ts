import { oncePerRequest } from "@softistx/alxia-graphql";
import DataLoader from "dataloader";
import type { ConsoleContext, UserSecondFactorView } from "@/console/context";

/**
 * `TenantUser.secondFactor` of one tenant, batched per request: a page of users
 * reads their records once (`ConsoleUsers.secondFactors`), not once per row.
 * The users module wraps `Mutation` in `freshPerMutation`, so a field read
 * after a reset sees the write.
 */
export const secondFactorLoader = (
  ctx: ConsoleContext,
  tenantId: string,
): DataLoader<string, UserSecondFactorView> =>
  oncePerRequest(
    ctx,
    `users.secondFactor:${tenantId}`,
    () => new DataLoader((ids) => ctx.users.secondFactors(tenantId, ids)),
  );
