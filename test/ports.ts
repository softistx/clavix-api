import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { noInvitationHooks, noThrottle, noUserThrottle } from "@/config/no-ops";
import type { AgentKindsOf, AgentsReader } from "@/modules/clients";
import {
  createKeyGenerations,
  KeysService,
  type TenantKeys,
} from "@/modules/keys";
import { createSecretBox } from "@/modules/sign-in-methods";
import { TenantSocialService } from "@/modules/tenants";
import type { ConnectionsOf, InvitationHooks } from "@/modules/users";
import { buildTenantJanus, ephemeralSecondFactorKeys } from "@/modules/users";
import type { DomainDirectory } from "@/tenancy/resolver";

/**
 * The ports a spec does not care about, bound to quiet no-ops. A service never
 * defaults a port (AGENTS.md "Ports are required and bound in `src/config/*`"),
 * so a spec that builds one spreads the helper for the ports it ignores and
 * writes the ports it checks after it.
 */

/** `TenantsService`: the platform apex and the three hooks, none of them listening. */
export const quietTenants = {
  domain: env.CLAVIX_DOMAIN,
  onHostsChanged: () => {},
  hostsOf: (): string[] => [],
  onCreated: () => {},
};

/** `TenantSocialService` on the wired tenants collection: no cache to tell. */
export const quietSocial = () =>
  new TenantSocialService(mongo.db.tenants, {
    ...quietTenants,
    now: () => new Date(),
    log: () => {},
  });

/** `DomainsService`: no cache to tell, no slug host, no admin event recorded. */
export const quietDomains = {
  onHostsChanged: () => {},
  slugHostOf: async () => undefined,
  record: async () => {},
};

/** The resolver's custom domains: none. Only slug hosts resolve. */
export const noCustomDomains = {
  domains: {
    tenantOfHost: async () => undefined,
    primaryHostOf: async () => undefined,
    verifiedHostsOf: async () => [],
  } satisfies DomainDirectory,
  lookupById: async () => undefined,
};

/** The OAuth issuers' ports of a tenant with no resource, no role, no exchange rule, no agent and no listener. */
export const quietOAuth = {
  resourcesFor: () => ({}),
  rolesFor: () => async (): Promise<string[]> => [],
  permissionsFor: () => async (): Promise<string[] | null> => null,
  attributesFor: () => async (): Promise<Record<string, unknown>> => ({}),
  attributeScopesFor: () => async (): Promise<Record<string, never>> => ({}),
  exchangeRulesFor: () => async () => null,
  agentCheckFor: () => async () => false,
  eventsFor: () => () => {},
};

/** The enterprise connections of a tenant with none. */
export const noConnections: ConnectionsOf = {
  sourceOf: () => ({
    findConnection: async () => null,
    findConnectionByDomain: async () => null,
  }),
  resolveHost: () => undefined,
  fetch: () => undefined,
  jitAllowed: async () => false,
};

/** A box for the tenants' social secrets under a key of its own. */
export const testSecrets = () =>
  createSecretBox(crypto.getRandomValues(new Uint8Array(32)));

/** The janus ports of a tenant's users that a spec does not check. */
export const quietUsers = {
  secondFactorKeys: ephemeralSecondFactorKeys(),
  secrets: testSecrets(),
  connections: noConnections,
  invitationHooks: () => noInvitationHooks,
  events: () => () => {},
};

/** `buildTenantJanus` with every port quiet, and the invitation hooks the spec checks (none by default). */
export const quietJanus = (
  db: Parameters<typeof buildTenantJanus>[0],
  tenant: Parameters<typeof buildTenantJanus>[1],
  hooks: InvitationHooks = noInvitationHooks,
) =>
  buildTenantJanus(
    db,
    tenant,
    () => {},
    quietUsers.secrets,
    hooks,
    () => {},
    quietUsers.secondFactorKeys,
    noConnections,
  );

/** The throttles of a base without Redis: no extra limit. */
export const quietThrottles = {
  signInThrottle: noThrottle,
  passkeyThrottle: noThrottle,
  homeRealmThrottle: noThrottle,
  ssoStartThrottle: noThrottle,
  verifyThrottle: noUserThrottle,
  deviceThrottle: noUserThrottle,
};

/** A tenant with no agents: none told apart, nothing to remove. */
export const noAgents: AgentsReader = {
  kinds: async () => new Map(),
  remove: async () => {},
};

/** Listing filter with no agents told apart. */
export const noAgentKinds: AgentKindsOf = async () => new Map();

/** `KeysService` over some tenant keys: a silent log, the system clock unless the spec fixes one. */
export const quietKeys = (
  keys: TenantKeys,
  now: () => Date = () => new Date(),
  log: (message: string) => void = () => {},
) => new KeysService({ keys, generations: createKeyGenerations(), now, log });
