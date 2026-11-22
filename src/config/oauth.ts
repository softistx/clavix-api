import { oauthListener } from "@/events/oauth-listener";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import type { AuthFor, ClaimsFor } from "@/oauth/ports";
import { withPublicDocuments } from "@/oauth/public-documents";
import { withTenantState } from "@/oauth/tenant-state";
import { withAgentRegistration } from "./agents-registration";
import { attributesFor } from "./attributes";
import { agentCheckFor, exchangeRulesFor } from "./client-policies";
import { env } from "./env";
import { eventBus } from "./events";
import { dpopNonceSecret, keyGenerations, keysService } from "./keys";
import { oauthDb } from "./oauth-db";
import { resourcesFor } from "./resources";
import { rolesFor } from "./roles";
import { clockMs, janusClock } from "./runtime";
import { tenantResolver } from "./tenancy";
import { metadataThrottle, registerThrottle } from "./throttle";
import { usageService } from "./usage";

// The app's OAuth issuers with the real tenant resolver, database and signing
// keys and the tenants' stored resources (`resources:create`). The entry point
// calls this with the end-user authentication and claims (`authFor`,
// `claimsFor`) and passes the result to `createApp({ oauth })`. A suspended or
// deleted tenant's `/authorize` and `/token` are refused; the JWKS and discovery documents are served from memory (`withPublicDocuments`), and a token issued
// counts its user as active this month (`withTenantState`).
export const createIssuers = (authFor: AuthFor, claimsFor: ClaimsFor) =>
  withTenantState(
    withPublicDocuments(
      withAgentRegistration(
        createClavixOAuthIssuers({
          resolver: tenantResolver,
          db: oauthDb,
          signingKeysFor: keysService.signingKeysFor,
          dpopNonceSecret,
          authFor,
          clock: janusClock,
          claimsFor,
          resourcesFor,
          rolesFor,
          attributesFor,
          exchangeRulesFor,
          agentCheckFor,
          metadataPorts: env.CLAVIX_METADATA_PORTS,
          eventsFor: (tenant) =>
            oauthListener(tenant.tenantId, tenant.issuer, eventBus),
        }),
        registerThrottle,
        metadataThrottle,
      ),
      { resolver: tenantResolver, generations: keyGenerations, now: clockMs },
    ),
    {
      resolver: tenantResolver,
      onActive: (tenantId, userId) =>
        usageService.recordActive(tenantId, userId),
    },
  );
