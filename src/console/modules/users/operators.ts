import { denial } from "@softistx/janus-graphql";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import type { ConsoleContext } from "../../context";

/**
 * Disabling or deleting a `clavix` user who holds a platform role or owns a
 * tenant is a membership change: it needs `manage` on the platform, not the
 * `edit` the field asks (an admin must not remove an owner).
 */
export async function keepOwners(
  ctx: ConsoleContext,
  tenant: { slug: string },
  userId: string,
) {
  if (tenant.slug !== PLATFORM_TENANT_SLUG) return;
  const owns =
    (await ctx.access.platformRole(userId)) !== null ||
    (await ctx.access.memberships(userId)).some(({ role }) => role === "owner");
  if (owns && !(await ctx.canPlatform("manage"))) {
    throw denial("FORBIDDEN", "Not allowed");
  }
}
