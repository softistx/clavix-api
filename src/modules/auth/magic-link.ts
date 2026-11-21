import { JanusError } from "@softistx/janus";
import type { TenantJanus } from "@/modules/users/tenant-janus";
import { fail } from "@/shared/errors";
import { afterAnswer } from "./outbox";
import { createIfOpen, type SignInDeps } from "./sign-in";

const LIFESPAN_MS = 15 * 60_000; // = MAGIC_LINK_LIFESPAN ("15m"), checked by magic-link.spec.ts

/** The surface does not exist while the switch is off: 404, nothing counted, issued or sent. */
export const magicLinkDisabled = () =>
  fail("MAGIC_LINK_DISABLED", "Magic-link sign-in is disabled", {
    status: 404,
  });

/**
 * Counts the request (past the limit: MAIL_THROTTLED), then, after the answer,
 * creates the account when sign-up is open, looks the address up and mails the
 * link. An unknown address on a closed tenant writes nothing and sends
 * nothing; the answer is the same either way. janus 0.57 refuses to enrol a
 * second factor or a passkey while the e-mail is unproved (EMAIL_UNVERIFIED),
 * so a link that proves it first has nothing of a squatter's to wipe.
 */
export async function requestMagicLink(
  { auth, mail, signUp }: SignInDeps,
  email: string,
) {
  const pending = await auth.magicLink.prepare(email);
  afterAnswer(async () => {
    if (signUp) await createIfOpen(auth, email);
    const issued = await pending.send();
    if (issued !== null) await mail.magicLink(issued);
  });
  return { expiresAt: new Date(Date.now() + LIFESPAN_MS) };
}

/** Every refusal alike: the page offers a new link whatever went wrong. */
export const magicLinkInvalid = () =>
  fail("MAGIC_LINK_INVALID", "The link is invalid or has expired", {
    status: 401,
  });

export async function confirmMagicLink(
  auth: TenantJanus,
  token: string,
  options?: { deviceLabel?: string },
) {
  try {
    // A session, or the second-factor challenge of a user who holds a factor.
    return await auth.magicLink.confirm(token, options);
  } catch (error) {
    if (error instanceof JanusError) {
      if (error.code === "MAGIC_LINK_DISABLED") throw magicLinkDisabled();
      if (error.code !== "STORE_FAILED") throw magicLinkInvalid();
    }
    throw error;
  }
}
