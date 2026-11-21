import { authService } from "@/config/auth";
import { brandingService } from "@/config/branding";
import { connectionsService } from "@/config/connections";
import { consentService } from "@/config/consent";
import { invitationsService } from "@/config/invitations";
import { mfaService } from "@/config/mfa";
import { passkeysService } from "@/config/passkeys";
import { resourcesService } from "@/config/resources";
import { signInPolicyService } from "@/config/sign-in-policy";
import { domainsService, tenantsService } from "@/config/tenancy";
import { webhooksService } from "@/config/webhooks-service";

/**
 * The modules' services (D10). A module's entry is added as it adopts the
 * registry; process-lifetime objects stay in `src/config/`, so the
 * connections and tenants services, built there, are the ones wired here.
 * `services()` therefore returns the process-wide instance until a consumer
 * needs a per-request one (D10 follow-up).
 */
export const services = () => ({
  auth: authService,
  branding: brandingService,
  connections: connectionsService,
  consent: consentService,
  domains: domainsService,
  invitations: invitationsService,
  mfa: mfaService,
  passkeys: passkeysService,
  resources: resourcesService,
  signInPolicy: signInPolicyService,
  tenants: tenantsService,
  webhooks: webhooksService,
});
