import type { ConsoleUsers } from "../../context";
import type { Pool } from "./pool";

/** The sessions of `ConsoleUsers`: a user's list, one revoked, all revoked. */
export const poolSessions = ({
  janus,
}: Pool): Pick<
  ConsoleUsers,
  "sessions" | "revokeSession" | "revokeSessions"
> => ({
  async sessions(tenantId, id) {
    const auth = await janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return [];
    return (await auth.sessions.list(user)).map(
      ({ id, device, createdAt, authenticatedAt, lastUsedAt, expiresAt }) => ({
        id,
        device,
        createdAt,
        authenticatedAt,
        lastUsedAt,
        expiresAt,
      }),
    );
  },
  async revokeSession(tenantId, id, sessionId) {
    const auth = await janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return false;
    return auth.sessions.revoke(user, sessionId);
  },
  async revokeSessions(tenantId, id) {
    const auth = await janus(tenantId);
    if ((await auth.findUser(id)) === null) return 0;
    return auth.signOutEverywhere(id);
  },
});
