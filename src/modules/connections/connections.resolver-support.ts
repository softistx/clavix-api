import { denial } from "@softistx/janus-graphql";
import { janusIssuers } from "@/config/users";
import type { Context } from "@/http/context";
import { services } from "@/modules/services";
import { requireLive } from "@/tenancy/live";

/**
 * The tenant and its janus for a home-realm question, before anything is
 * read: unknown or suspended tenants are refused, the answer is never cached
 * and the address is counted against the throttle.
 */
export async function homeRealmScope(ctx: Context) {
  const [auth, tenant] = await Promise.all([
    janusIssuers.forRequest(ctx.request),
    ctx.tenant(),
  ]);
  if (auth === null || tenant === null) {
    throw denial("NOT_FOUND", "No such tenant");
  }
  requireLive(tenant);
  ctx.set.headers.set("cache-control", "no-store");
  await ctx.homeRealmThrottle.check({
    tenantId: tenant.tenantId,
    ip: ctx.ip,
  });
  return { auth, tenant };
}

/** The connection a home realm names, as the sign-in page shows it; `null` when none is offered. */
export async function offeredConnection(
  tenantId: string,
  connectionId: string,
) {
  const doc = await services().connections.find(tenantId, connectionId);
  return doc === undefined || !doc.enabled
    ? null
    : { connectionId, name: doc.name };
}
