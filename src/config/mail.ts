import { createPlatformMailer } from "@/mail/mailer";
import { createTenantMail } from "@/mail/tenant-mail";
import { env } from "./env";

// The platform mailer (SMTP behind CLAVIX_SMTP_URL, a memory mailer without
// it) and the e-mails of a tenant over it.
export const mailer = createPlatformMailer(env.CLAVIX_SMTP_URL);
export const tenantMail = createTenantMail({
  mailer,
  domain: env.CLAVIX_DOMAIN,
});
