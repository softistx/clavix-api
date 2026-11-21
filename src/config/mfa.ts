import { MfaService } from "@/modules/mfa";
import { tenantMail } from "./mail";
import { usageService } from "./usage";
import { janusIssuers } from "./users";

/** The second factor and the step-up over the tenants' janus instances, their mail and the MAU counter. */
export const mfaService = new MfaService({
  issuers: janusIssuers,
  mailOf: tenantMail,
  usage: usageService,
});
