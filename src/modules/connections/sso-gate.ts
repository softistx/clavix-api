import { GraphQLError } from "graphql";
import { connectionsService } from "@/config/connections";
import type { TenantJanus } from "@/users/tenant-janus";

/** The address signs in through its company's identity provider only (D3). */
export const ssoRequired = () =>
  new GraphQLError("This address signs in through single sign-on", {
    extensions: { code: "SSO_REQUIRED", http: { status: 403 } },
  });

/** Before any code or link is sent: refuses an address whose domain requires single sign-on. */
export async function requireNoSso(
  tenantId: string,
  email: string,
): Promise<void> {
  if (await connectionsService.requiresSso(tenantId, email)) {
    throw ssoRequired();
  }
}

/** Whether the user's address requires single sign-on; `false` for a user that no longer exists. */
async function userRequiresSso(
  auth: TenantJanus,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const user = await auth.findUser(userId);
  return (
    user !== null &&
    (await connectionsService.requiresSso(tenantId, user.email))
  );
}

/** A sign-in with no session yet (a second-factor challenge): refused for a user who must use single sign-on. */
export async function requireNoSsoForUser(
  auth: TenantJanus,
  tenantId: string,
  userId: string,
): Promise<void> {
  if (await userRequiresSso(auth, tenantId, userId)) throw ssoRequired();
}

/** The session a sign-in opened: by id when janus returned it, else every non-federated one created since the attempt began. */
export type OpenedSession = { id: string } | { since: Date };

/**
 * A sign-in that already opened a session (a passkey, a code, a link, which
 * know the user only once they are done): for a user who must use single
 * sign-on the session it opened is revoked before the refusal, so it is dead
 * on the server. A code or a link sets its cookie after this check, so none
 * is sent; janus-graphql's passkey sign-in queues its own cookie, which then
 * names a revoked session.
 */
export async function revokeIfSso(
  auth: TenantJanus,
  tenantId: string,
  userId: string,
  opened: OpenedSession,
): Promise<void> {
  if (!(await userRequiresSso(auth, tenantId, userId))) return;
  if ("id" in opened) {
    await auth.sessions.revoke(userId, opened.id);
  } else {
    for (const session of await auth.sessions.list(userId)) {
      if (
        session.revokedAt === null &&
        session.createdAt >= opened.since &&
        !session.amr.includes("fed")
      ) {
        await auth.sessions.revoke(userId, session.id);
      }
    }
  }
  throw ssoRequired();
}
