import type { Clock } from "@softistx/janus";
import { RESERVED_ACCESS_TOKEN_CLAIMS } from "@softistx/janus-oauth";
import { createMongoDPoPReplayCache } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";
import { DPOP_ALGORITHMS } from "@/modules/resources";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { AttributesFor, RolesFor } from "./ports";
import { type MetadataTransport, registrationOf } from "./registration";

/** The userinfo endpoint of an issuer, also the resource of OIDC clients that send none. */
export const userinfoOf = (issuer: string) => `${issuer}/userinfo`;

/**
 * RFC 8628: served by every tenant, gated per client by its grants (the
 * device URN is never implied). The page is the hosted `/device` of the
 * issuer's own host; `/device_authorization` is janus's endpoint. An agent (a
 * client that registered itself) gets no device grant (D11).
 */
export const deviceOf = (tenant: ResolvedTenant) => ({
  verificationUri: `${tenant.issuer}/device`,
  dynamicClients: false,
});

/**
 * Agents (D7, D8): off unless the tenant opted in; `/register` is ours
 * (`register-route.ts`), not janus's.
 */
export const registrationFor = (
  tenant: ResolvedTenant,
  transport: MetadataTransport | undefined,
  ports: readonly number[] | undefined,
) => registrationOf(tenant.oauth.agents, transport, ports);

/**
 * RFC 9449: proofs are single-use (the Mongo replay cache is shared by every
 * instance) and carry a server nonce; `required` makes every client of the
 * tenant send one. A client may also require it alone (`dpopBoundAccessTokens`).
 */
export const dpopOf = (
  tenant: ResolvedTenant,
  db: Db,
  clock: Clock,
  nonceSecret: string,
) => ({
  algorithms: DPOP_ALGORITHMS,
  required: tenant.oauth.dpop.required,
  replay: createMongoDPoPReplayCache(db, { clock }),
  nonce: { secret: nonceSecret },
});

interface TokenGrant {
  subject: string;
  /** `client` for a client credentials token: the subject is a client id, not a user. */
  subjectType?: "client" | "user";
  audience: string;
  scopes: readonly string[];
  authTime?: Date;
  acr?: string;
  amr?: readonly string[];
}

/** The claims of the grant itself: `auth_time`, `acr` and `amr`, each only when the grant records it. */
const grantClaims = ({
  authTime,
  acr,
  amr,
}: {
  authTime: Date | undefined;
  acr: string | undefined;
  amr: readonly string[] | undefined;
}) => ({
  ...(authTime === undefined
    ? {}
    : { auth_time: Math.floor(authTime.getTime() / 1000) }),
  ...(acr === undefined ? {} : { acr }),
  ...(amr === undefined ? {} : { amr: [...amr] }),
});

const RESERVED: ReadonlySet<string> = new Set(RESERVED_ACCESS_TOKEN_CLAIMS);

/** The claims without the names the server owns (a catalogue refuses them at creation; this keeps a token valid whatever the data). */
const omitReserved = (claims: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(claims).filter(([name]) => !RESERVED.has(name)),
  );

/**
 * Runs on every code exchange and refresh: a refreshed token carries the
 * user's current roles. The audience is the token's resource. `acr`, `amr` and
 * `auth_time` are the grant's, the values of the ID token (RFC 9068, RFC
 * 9470); a grant that records none adds none. A machine has no attributes
 * either. An attribute claim never takes the place of one the server owns:
 * its key is dropped when reserved, and the claims above win over it.
 */
export const accessTokenClaims =
  (tenant: ResolvedTenant, rolesFor: RolesFor, attributesFor: AttributesFor) =>
  async ({
    subject,
    audience,
    scopes,
    authTime,
    acr,
    amr,
    subjectType,
  }: TokenGrant) => {
    if (subjectType === "client") return grantClaims({ authTime, acr, amr });
    const resource = audience === userinfoOf(tenant.issuer) ? null : audience;
    return {
      ...omitReserved(await attributesFor(tenant)(subject, scopes, resource)),
      roles: await rolesFor(tenant)(subject, resource),
      ...grantClaims({ authTime, acr, amr }),
    };
  };
