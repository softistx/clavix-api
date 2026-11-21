import type { Mailer, MemoryMailer } from "@softistx/mail";

const isMemoryMailer = (mailer: Mailer): mailer is MemoryMailer =>
  "sent" in mailer && "failNext" in mailer && "clear" in mailer;

/** The platform mailer as the memory mailer the specs run on: fails the spec when SMTP is configured. */
export function memoryMailerOf(mailer: Mailer): MemoryMailer {
  if (!isMemoryMailer(mailer)) {
    throw new Error("expected the platform mailer to be the memory mailer");
  }
  return mailer;
}
