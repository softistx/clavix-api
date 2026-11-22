import { agentClientsService } from "@/config/agent-clients";
import { attributesService } from "@/config/attributes";
import { authEventsService } from "@/config/audit";
import { authService } from "@/config/auth";
import { brandingService } from "@/config/branding";
import { clientPoliciesService } from "@/config/client-policies";
import { clientsService } from "@/config/clients";
import {
  connectionRecordsService,
  connectionSourcesService,
} from "@/config/connections";
import { consentService } from "@/config/consent";
import { invitationsService } from "@/config/invitations";
import { keysService } from "@/config/keys";
import { mfaService } from "@/config/mfa";
import { oauthPolicyService } from "@/config/oauth-policy";
import { passkeysService } from "@/config/passkeys";
import { profilePoliciesService } from "@/config/profile";
import { resourcesService } from "@/config/resources";
import { rolesService } from "@/config/roles";
import { signInPolicyService } from "@/config/sign-in-policy";
import {
  domainsService,
  tenantRetentionService,
  tenantSocialService,
  tenantsService,
} from "@/config/tenancy";
import { usageService } from "@/config/usage";
import { usersService } from "@/config/users";
import { webhooksService } from "@/config/webhooks-service";

/**
 * The modules' services (D10). A module's entry is added as it adopts the
 * registry; process-lifetime objects stay in `src/config/`, so the
 * connections and tenants services, built there, are the ones wired here.
 * `services()` therefore returns the process-wide instance until a consumer
 * needs a per-request one (D10 follow-up).
 */
export const services = () => ({
  agents: agentClientsService,
  audit: authEventsService,
  attributes: attributesService,
  auth: authService,
  branding: brandingService,
  clientPolicies: clientPoliciesService,
  clients: clientsService,
  connectionSources: connectionSourcesService,
  connections: connectionRecordsService,
  consent: consentService,
  domains: domainsService,
  invitations: invitationsService,
  keys: keysService,
  mfa: mfaService,
  oauthPolicy: oauthPolicyService,
  passkeys: passkeysService,
  profilePolicies: profilePoliciesService,
  resources: resourcesService,
  roles: rolesService,
  signInPolicy: signInPolicyService,
  tenants: tenantsService,
  tenantSocial: tenantSocialService,
  tenantRetention: tenantRetentionService,
  usage: usageService,
  users: usersService,
  webhooks: webhooksService,
});
