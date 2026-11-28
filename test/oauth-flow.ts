import {
  createMemorySigningKeys,
  rotateSigningKeys,
  type SigningKeyStore,
} from "@softistx/janus-oauth";
import { withAgentRegistration } from "@/config/agents-registration";
import { agentCheckFor, exchangeRulesFor } from "@/config/client-policies";
import { mongo } from "@/config/db";
import { noDetailTypes, noThrottle } from "@/config/no-ops";
import { oauthDb } from "@/config/oauth-db";
import { registerStoredResource, resourcesFor } from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { registerClient } from "@/modules/clients";
import {
  type ClavixOAuthOptions,
  createClavixOAuthIssuers,
} from "@/oauth/issuers";
import type {
  AttributeScopesFor,
  AttributesFor,
  AuthFor,
  ClaimsFor,
  PermissionsFor,
  RolesFor,
} from "@/oauth/ports";
import type {
  MetadataThrottle,
  RegisterThrottle,
} from "@/oauth/register-throttle";
import type { MetadataTransport } from "@/oauth/registration";
import { quietOAuth } from "~/ports";
import {
  basic,
  type FlowClient,
  requestsOf,
  stepsOf,
} from "./oauth-flow-steps";
import { createTenantParOff } from "./tenant-par-off";

export const DOMAIN = (await import("@/config/env")).env.CLAVIX_DOMAIN;
export const REDIRECT = "https://app.example/callback";
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });

interface FlowOptions {
  /** The user's own claims (the user's e-mail by default). */
  claimsFor?: ClaimsFor;
  rolesFor?: RolesFor;
  permissionsFor?: PermissionsFor;
  attributesFor?: AttributesFor;
  attributeScopesFor?: AttributeScopesFor;
  /** What the `/register` route throttles with (none by default). */
  registerThrottle?: RegisterThrottle;
  /** What `/authorize` and `/par` throttle a metadata document fetch with (none by default). */
  metadataThrottle?: MetadataThrottle;
  /** Fetches and resolves metadata documents (the specs' stand-in for the network). */
  metadataTransport?: MetadataTransport;
  /** The OAuth events listener of a tenant (none by default); the specs of the sign-in log pass the real one. */
  eventsFor?: ClavixOAuthOptions["eventsFor"];
}

const authFor: AuthFor = () => ({
  authenticate: async () => null,
  findUser: async (id) => ({ id, active: true }),
});
const claimsFor: ClaimsFor = () => async (subject) => ({
  email: `${subject.id}@end.test`,
  email_verified: true,
});

/** One in-memory signing key store per tenant. */
function signingKeysByTenant() {
  const keys = new Map<string, SigningKeyStore>();
  return (tenantId: string) => {
    let store = keys.get(tenantId);
    if (store === undefined) {
      store = createMemorySigningKeys();
      keys.set(tenantId, store);
    }
    return store;
  };
}

/** The issuers over the test database, with the fake user pool. */
function issuersOf(
  options: FlowOptions,
  signingKeysFor: (tenantId: string) => SigningKeyStore,
) {
  const base = createClavixOAuthIssuers({
    ...quietOAuth,
    clock: { now: () => new Date() },
    dpopNonceSecret: "spec-dpop-nonce-secret",
    resolver: tenantResolver,
    db: oauthDb,
    signingKeysFor,
    authFor,
    claimsFor: options.claimsFor ?? claimsFor,
    resourcesFor,
    exchangeRulesFor,
    agentCheckFor,
    ...(options.eventsFor === undefined
      ? {}
      : { eventsFor: options.eventsFor }),
    ...(options.rolesFor === undefined ? {} : { rolesFor: options.rolesFor }),
    ...(options.permissionsFor === undefined
      ? {}
      : { permissionsFor: options.permissionsFor }),
    ...(options.attributesFor === undefined
      ? {}
      : { attributesFor: options.attributesFor }),
    ...(options.attributeScopesFor === undefined
      ? {}
      : { attributeScopesFor: options.attributeScopesFor }),
    ...(options.metadataTransport === undefined
      ? {}
      : { metadataTransport: options.metadataTransport }),
  });
  return withAgentRegistration(
    base,
    options.registerThrottle ?? noThrottle,
    options.metadataThrottle ?? noThrottle,
  );
}

/** A tenant with a signing key, a confidential client `backend` and these resources (each with a `read` scope). */
function setUpOf(
  signingKeysFor: (tenantId: string) => SigningKeyStore,
  clients: Record<string, FlowClient>,
) {
  return async (
    slug: string,
    resourceUris: readonly string[] = [],
    options: { par?: boolean } = {},
  ) => {
    // A new tenant requires pushed authorization requests (M3): the specs that
    // authorize directly turn it off, the PAR specs keep it.
    const input = { slug, name: slug };
    const { id } =
      options.par === true
        ? await tenantsService.create(input)
        : await createTenantParOff(tenantsService, input);
    const tenant = await tenantResolver.resolveHost(`${slug}.${DOMAIN}`);
    if (tenant === null) throw new Error("tenant not resolved");
    await rotateSigningKeys(signingKeysFor(tenant.tenantId), {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
    for (const uri of resourceUris) {
      await registerStoredResource({ tenant: slug, uri, scopes: ["read"] });
    }
    const registered = await registerClient(
      {
        detailTypes: noDetailTypes,
        db: oauthDb,
        findTenant,
        now: () => new Date(),
      },
      {
        tenant: slug,
        name: "Back end",
        clientId: "backend",
        redirectUris: [REDIRECT],
        type: "confidential",
      },
    );
    clients[slug] = { id: "backend", secret: registered.clientSecret ?? "" };
    return { tenantId: id };
  };
}

/**
 * A real OAuth flow (authorize, approve, code exchange) against the tenants of
 * the test database, with a fake user pool: every user id is known, claims are
 * the user's e-mail. For the specs that read what a token carries or whether
 * it still works.
 */
export function createFlow(options: FlowOptions = {}) {
  const signingKeysFor = signingKeysByTenant();
  const issuers = issuersOf(options, signingKeysFor);
  const requests = requestsOf(issuers, DOMAIN);
  const clients: Record<string, FlowClient> = {};
  return {
    issuers,
    setUp: setUpOf(signingKeysFor, clients),
    ...stepsOf(issuers, requests, clients, REDIRECT),
    ...requests,
    basic,
    clients,
  };
}
