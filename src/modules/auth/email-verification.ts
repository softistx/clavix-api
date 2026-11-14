import { JanusError, MailThrottledError } from "@softistx/janus";
import type { JanusMail } from "@softistx/janus-mail";
import { GraphQLError } from "graphql";
import type { TenantJanus } from "@/users/tenant-janus";
import { afterAnswer } from "./outbox";
import { emailVerificationThrottled } from "./verification-throttle";

/** Every refusal alike: the page offers a new link whatever went wrong. */
export const emailVerificationInvalid = () =>
  new GraphQLError("The verification link is invalid or has expired", {
    extensions: { code: "EMAIL_VERIFICATION_INVALID", http: { status: 400 } },
  });

/**
 * Mails the signed-in user a verification link. Always `true`: janus counts
 * the address (past five in 10 minutes: `EMAIL_VERIFICATION_THROTTLED`, the
 * same code as our own limits), and, after the answer, `send()` issues a token
 * for the active, unverified holder of the address only, so an already
 * verified user gets the same answer and no mail. The link goes to the
 * signed-in account's own address, never to another account that has since
 * come to hold it.
 */
export async function requestEmailVerification(
  { auth, mail }: { auth: TenantJanus; mail: JanusMail },
  user: { id: string; email: string },
): Promise<true> {
  try {
    // `prepare(email)` then the id check, not `send(user)`: `send(user)` issues
    // for the current address whatever its state, so a verified user would be mailed.
    const pending = await auth.verifyEmail.prepare(user.email);
    afterAnswer(async () => {
      const issued = await pending.send();
      if (issued !== null && issued.user.id === user.id) {
        await mail.verifyEmail(issued, {
          name: issued.user.name ?? issued.email,
        });
      }
    });
  } catch (error) {
    if (error instanceof MailThrottledError) {
      throw emailVerificationThrottled(error.retryAfter ?? 600);
    }
    throw error;
  }
  return true;
}

/**
 * Proves the address from the token, for the signed-in account only
 * (`{ user }`): another account's token is refused and left unspent. No first
 * proof: the password and second factor stay. Unknown, spent, expired and
 * stale tokens are one `EMAIL_VERIFICATION_INVALID`; a store outage stays 503.
 */
export async function confirmEmailVerification(
  auth: TenantJanus,
  token: string,
  userId: string,
) {
  try {
    return await auth.verifyEmail.confirm(token, { user: userId });
  } catch (error) {
    if (error instanceof JanusError && error.code !== "STORE_FAILED") {
      throw emailVerificationInvalid();
    }
    throw error;
  }
}
