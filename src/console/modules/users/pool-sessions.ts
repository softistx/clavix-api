import type { ConsoleUsers } from "../../context";
import { type Pool, view } from "./pool";

/** The sessions of `ConsoleUsers`: a user's list, one revoked, all revoked. */
export const poolSessions = ({
  janus,
}: Pool): Pick<
  ConsoleUsers,
  | "sessions"
  | "revokeSession"
  | "revokeSessions"
  | "secondFactor"
  | "resetSecondFactor"
> => ({
  async secondFactor(tenantId, id) {
    const auth = await janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return { enabled: false, recoveryCodesLeft: null };
    return {
      enabled: user.hasSecondFactor === true,
      recoveryCodesLeft: await auth.secondFactor.recoveryCodesLeft(user),
    };
  },
  async resetSecondFactor(tenantId, id) {
    const auth = await janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return null;
    await auth.secondFactor.disable(user);
    return view((await auth.findUser(id)) ?? user);
  },
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
