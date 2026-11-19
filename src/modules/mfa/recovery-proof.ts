import { createMongoStores } from "@softistx/janus-mongo";
import { oauthDb } from "@/config/oauth-db";
import type { Context } from "@/http/context";

/** RFC 8176: a recovery code, in place of the `otp` janus records for any second-factor code. */
export const RECOVERY_AMR = "rec";

/**
 * `recoverSecondFactor` opened a session for `userId` at or after `since`:
 * janus records `otp` and `mfa` for a recovery code as for an authenticator
 * code and answers which one it was (`method: 'recovery'`, nxgt-janus#950)
 * without storing it. The session's `amr` then states `rec` in place of
 * `otp`, so the ID and access tokens tell a recovery-code sign-in apart
 * (RFC 8176). The response's cookie is set after the resolver, so the session
 * is the user's newest one since the sign-in. Never throws: the sign-in stands.
 */
export async function markRecoverySession(
  ctx: Context,
  userId: string,
  since: Date,
): Promise<void> {
  try {
    const tenant = await ctx.tenant();
    if (tenant === null) return;
    const { sessions } = createMongoStores(oauthDb, {
      partition: tenant.partition,
    });
    if (sessions.listUserSessions === undefined) return;
    const opened = (await sessions.listUserSessions(userId, new Date()))
      .filter((session) => session.authenticatedAt.getTime() >= since.getTime())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (opened === undefined) return;
    const marked = [
      ...new Set(
        (opened.amr ?? []).map((value) =>
          value === "otp" ? RECOVERY_AMR : value,
        ),
      ),
    ];
    await sessions.reauthenticateSession(
      opened.id,
      opened.authenticatedAt,
      marked,
    );
  } catch {
    // The proof stays `otp`: the sign-in is not undone by a failed mark.
  }
}
