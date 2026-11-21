import { PasskeysService } from "@/modules/passkeys";
import { usageService } from "./usage";
import { janusIssuers } from "./users";

/** The passkeys over the tenants' janus instances and the MAU counter. */
export const passkeysService = new PasskeysService({
  issuers: janusIssuers,
  usage: usageService,
});
