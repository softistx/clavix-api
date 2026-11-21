import { AuthService } from "@/modules/auth";
import { tenantMail } from "./mail";
import { usageService } from "./usage";
import { janusIssuers } from "./users";

/** The hosted sign-in (e-mail code, magic link, e-mail verification, sign-out) over the tenants' janus instances, their mail and the MAU counter. */
export const authService = new AuthService({
  issuers: janusIssuers,
  mailOf: tenantMail,
  usage: usageService,
});
