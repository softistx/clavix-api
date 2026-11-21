import type { Clock } from "@softistx/janus";
import { createMongoDPoPReplayCache } from "@softistx/janus-oauth-mongo";
import type { Db } from "mongodb";
import { DPOP_ALGORITHMS } from "@/modules/resources";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { RolesFor } from "./ports";
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
  authTime?: Date;
  acr?: string;
  amr?: readonly string[];
}

/**
 * Runs on every code exchange and refresh: a refreshed token carries the
 * user's current roles. The audience is the token's resource. `acr`, `amr` and
 * `auth_time` are the grant's, the values of the ID token (RFC 9068, RFC
 * 9470); a grant that records none adds none.
 */
export const accessTokenClaims =
  (tenant: ResolvedTenant, rolesFor: RolesFor) =>
  async ({
    subject,
    audience,
    authTime,
    acr,
    amr,
    subjectType,
  }: TokenGrant) => ({
    // A machine has no roles: its subject is a client id, not a user.
    ...(subjectType === "client"
      ? {}
      : {
          roles: await rolesFor(tenant)(
            subject,
            audience === userinfoOf(tenant.issuer) ? null : audience,
          ),
        }),
    ...(authTime === undefined
      ? {}
      : { auth_time: Math.floor(authTime.getTime() / 1000) }),
    ...(acr === undefined ? {} : { acr }),
    ...(amr === undefined ? {} : { amr: [...amr] }),
  });
