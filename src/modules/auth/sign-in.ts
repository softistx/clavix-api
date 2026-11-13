import { JanusError } from "@softistx/janus";
import type { JanusMail } from "@softistx/janus-mail";
import { GraphQLError } from "graphql";
import type { TenantJanus } from "@/users/tenant-janus";
import { afterAnswer } from "./outbox";

export interface SignInDeps {
  auth: TenantJanus;
  mail: JanusMail;
  /** Whether an unknown e-mail may open an account (`tenant.signUp`). */
  signUp: boolean;
}

const LIFESPAN_MS = 10 * 60_000; // = SIGN_IN_CODE_LIFESPAN ("10m"), checked by auth.spec.ts

/** Opens the account of an address on a tenant that allows sign-up; one that exists is left alone. */
export async function createIfOpen(auth: TenantJanus, email: string) {
  try {
    await auth.create({ email });
  } catch (error) {
    if (!(error instanceof JanusError && error.code === "LOGIN_TAKEN")) {
      throw error;
    }
  }
}

/**
 * Counts the request (past the limit: MAIL_THROTTLED), mints the challenge for
 * whoever asked, then, after the answer, creates the account when sign-up is
 * open, looks the address up and mails the code. An unknown address on a
 * closed tenant writes nothing and sends nothing; the visitor cannot tell.
 */
export async function requestSignInCode(
  { auth, mail, signUp }: SignInDeps,
  email: string,
) {
  const pending = await auth.signInCode.prepare(email);
  afterAnswer(async () => {
    if (signUp) await createIfOpen(auth, email);
    const issued = await pending.send();
    if (issued !== null) await mail.signInCode(issued);
  });
  return {
    challenge: pending.challenge,
    expiresAt: new Date(Date.now() + LIFESPAN_MS),
  };
}

/** Every refusal alike: a decoy challenge must not read differently from a real one. */
export const codeInvalid = () =>
  new GraphQLError("The code is wrong or has expired", {
    extensions: { code: "CODE_INVALID", http: { status: 401 } },
  });

export async function verifySignInCode(
  auth: TenantJanus,
  challenge: string,
  code: string,
  options?: { deviceLabel?: string },
) {
  try {
    return await auth.signInCode.confirm(challenge, code, options);
  } catch (error) {
    if (error instanceof JanusError && error.code !== "STORE_FAILED") {
      throw codeInvalid();
    }
    throw error;
  }
}
