import type { Context } from "@/http/context";
import { SERVERS, serverOf, type WithServers } from "./index";

/**
 * Revokes every standing OAuth grant of `userId` on the request's tenant, with
 * the access and refresh tokens they opened (janus-oauth `grants.revokeAll`);
 * answers how many grants it revoked. Nothing to revoke where no OAuth server
 * is mounted. For a user whose address was taken over by a social sign-in
 * (`SocialSignedIn.replaced`): janus drops their sessions, never their grants.
 */
export async function revokeOAuthGrants(
  ctx: Context,
  userId: string,
): Promise<number> {
  const source = (ctx as unknown as WithServers)[SERVERS];
  if (source === undefined) return 0;
  return (await serverOf(ctx)).grants.revokeAll({ id: userId });
}
