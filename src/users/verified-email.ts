import { GraphQLError } from "graphql";

/**
 * The refusal of an action that needs a proved e-mail address: HTTP 403 with
 * the stable code `EMAIL_UNVERIFIED`, the code janus answers for a passkey or
 * a second factor, so one client branch handles them all. The hosted account
 * page and the console both map it to "verify your e-mail first".
 */
export const emailUnverified = () =>
  new GraphQLError("Verify your e-mail first", {
    extensions: { code: "EMAIL_UNVERIFIED", http: { status: 403 } },
  });

/**
 * Throws `EMAIL_UNVERIFIED` (403) unless the user's e-mail is proved. Takes
 * the user as janus or the console directory reads it, so the console gate,
 * and later the e-mail change, share one check.
 */
export function requireVerifiedEmail(user: {
  readonly emailVerified: boolean;
}): void {
  if (!user.emailVerified) throw emailUnverified();
}
