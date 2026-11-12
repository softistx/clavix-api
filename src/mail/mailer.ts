import { createMemoryMailer, type Mailer } from "@softistx/mail";
import { createSmtpMailer } from "@softistx/mail-smtp";
import nodemailer from "nodemailer";

/** The one sender of the platform: `no-reply@<CLAVIX_DOMAIN>`. */
export const senderAddress = (domain: string) => `no-reply@${domain}`;

/**
 * The platform mailer: SMTP when a URL is given, else a memory mailer (dev and
 * tests: nothing leaves the process, `sent` holds what would have been).
 */
export function createPlatformMailer(smtpUrl: string | undefined): Mailer {
  return smtpUrl === undefined
    ? createMemoryMailer()
    : createSmtpMailer({ transporter: nodemailer.createTransport(smtpUrl) });
}
