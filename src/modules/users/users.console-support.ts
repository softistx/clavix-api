import { denial } from "@softistx/janus-graphql";
import type { ConsoleContext } from "@/console/context";
import { idArg, liveTenant, tenantIdOf } from "@/console/modules/ids";
import { userKey } from "@/console/modules/user-key";
import { keepOwners } from "./users.owners";
import { shape, target } from "./users.utils";

/** `disableUser` and `enableUser`: the flag written under the owner rule, then audited. */
export async function setActive(
  ctx: ConsoleContext,
  given: string,
  userId: string,
  active: boolean,
) {
  const tenantId = tenantIdOf(given);
  idArg(userId, "userId");
  const tenant = await liveTenant(ctx.directory, tenantId);
  // Under the user lock (taken by `keepOwners`) like the accept hooks: an
  // owner role is not granted to an account disabled meanwhile. Enabling goes
  // through it too: an operator an owner disabled is the owners' to bring back.
  const user = await keepOwners(
    ctx,
    tenant,
    userId,
    () => ctx.users.setActive(tenantId, userId, active),
    active ? "touch" : "disable",
    userKey(tenantId, userId),
  );
  if (user === null) throw denial("NOT_FOUND", "No such user");
  await ctx.audit(
    active ? "user.enable" : "user.disable",
    target("user", userId, tenantId),
  );
  return shape(user, tenantId);
}
