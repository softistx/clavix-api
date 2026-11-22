import {
  createMemoryConnections,
  oidcConnections,
} from "@softistx/janus-social";
import {
  discoverIssuer,
  type IssuerChecker,
} from "@/modules/connections/connections.discovery";
import {
  ConnectionDomainsService,
  ConnectionRecordsService,
  ConnectionSecretsService,
  ConnectionSourcesService,
} from "@/modules/connections/services";
import { systemTxtResolver } from "@/modules/domains";
import { hostOf } from "@/modules/tenants";
import { socialOf } from "@/modules/users";
import { mongo } from "./db";
import { env } from "./env";
import { connectionSecretBox } from "./keys";
import { clock, warn } from "./runtime";
import { tenantResolver, tenantsService } from "./tenancy";

// The accounts linked through a connection, counted by the tenant's own janus
// instance (`auth.social.countLinks`): its stores count within the tenant's
// partition, and the provider name is the connection's id. A tenant with no
// social instance has no link. `./users` imports this module, so `forTenant`
// is read at call time only.
const linkCount = async (tenantId: string, connectionId: string) => {
  const tenant = await tenantsService.find(tenantId);
  const resolved =
    tenant === undefined
      ? null
      : await tenantResolver.resolveHost(
          hostOf(tenant.slug, env.CLAVIX_DOMAIN),
        );
  const { forTenant } = await import("./users");
  const auth = resolved === null ? null : await forTenant(resolved);
  // Fail closed: a count that cannot be made must not read as "no link".
  if (auth === null) {
    throw new Error(`link count: tenant ${tenantId} has no instance`);
  }
  const withSocial = socialOf(auth);
  if (withSocial === null) return 0;
  return withSocial.social.countLinks({ provider: connectionId });
};

/** Whether an issuer's discovery document advertises `iss` (read through janus's guarded fetch; the connection is a throwaway). */
const advertisesIss = (issuer: string) =>
  oidcConnections({
    source: createMemoryConnections([]),
    redirectUri: "https://clavix.invalid/sign-in/sso/callback",
  }).advertisesIssParameter({ issuer });

/** The connection records of the tenants (reads, create, update, delete). The collection is tenant-owned: only this wiring and its module reach it. */
export const connectionRecordsService = new ConnectionRecordsService(
  mongo.db.connections,
  connectionSecretBox,
  { links: linkCount, advertisesIss },
);

/** The domains a connection claims and their TXT verification. */
export const connectionDomainsService = new ConnectionDomainsService(
  connectionRecordsService,
  connectionSecretBox,
  { txt: systemTxtResolver(), now: clock },
);

/** The sealed client secrets: replacement and re-sealing under a new key. */
export const connectionSecretsService = new ConnectionSecretsService(
  connectionRecordsService,
  connectionSecretBox,
  warn,
);

/** The janus connection source, the home-realm lookups and the SSO gate. */
export const connectionSourcesService = new ConnectionSourcesService(
  connectionRecordsService,
  connectionSecretBox,
  warn,
);

/** Reads an issuer's discovery document for the console's check (the network). */
export const issuerChecker: IssuerChecker = discoverIssuer;
