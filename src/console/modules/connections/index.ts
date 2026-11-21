import type { ObjectId } from "mongodb";
import {
  connectionsService as connections,
  issuerChecker,
} from "@/config/connections";
import { tenantsService } from "@/config/tenancy";
import type { Resolvers } from "@/generated/console/resolvers";
import {
  type ConnectionDoc,
  ConnectionError,
  txtNameOf,
} from "@/modules/connections";
import { callbackUrlOf } from "@/modules/sign-in-methods/social";
import { effectiveQuotas } from "@/modules/tenants";
import { fail } from "@/shared/errors";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import { catalogTenant } from "../catalog-support";
import { tenantArg } from "../ids";
import { issuerFor } from "../sign-in-methods";
import { refusal } from "../tenants/errors";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

export const connectionsGuards: Guards = {
  "Query.connections": view,
  "Query.connection": view,
  // An outbound request on the admin's behalf: `edit`, not `view`.
  "Query.checkConnection": edit,
  "Mutation.createConnection": edit,
  "Mutation.updateConnection": edit,
  "Mutation.setConnectionSecret": edit,
  "Mutation.deleteConnection": edit,
  "Mutation.addConnectionDomain": edit,
  "Mutation.verifyConnectionDomain": edit,
  "Mutation.removeConnectionDomain": edit,
};

export const connectionsAudits: Audits = {
  "Mutation.createConnection": "connection.create",
  "Mutation.updateConnection": "connection.update",
  "Mutation.setConnectionSecret": "connection.setSecret",
  "Mutation.deleteConnection": "connection.delete",
  "Mutation.addConnectionDomain": "connection.addDomain",
  "Mutation.verifyConnectionDomain": "connection.verifyDomain",
  "Mutation.removeConnectionDomain": "connection.removeDomain",
};

const STATUS = {
  BAD_USER_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONNECTION_IN_USE: 409,
  DOMAIN_TAKEN: 409,
  DOMAIN_NOT_VERIFIED: 409,
  VERIFY_COOLDOWN: 429,
  ISSUER_REFUSED: 400,
  ISSUER_UNREACHABLE: 502,
} as const;

// The service's refusals as the contract's GraphQL errors (the quota one too).
async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ConnectionError) {
      throw fail(error.code, error.message, {
        status: STATUS[error.code],
        field: error.field,
        retryAfter: error.retryAfter,
      });
    }
    throw refusal(error);
  }
}

// What an admin event names: the connection and its tenant. Never the issuer, a domain or a secret.
const target = (tenantId: ObjectId, id: string) => ({
  type: "connection",
  id,
  tenantId: tenantId.toHexString(),
});

/** The `Exclusive` key of a tenant's connections (the quota count and the insert are not atomic; domain claims must not race). */
const connectionsKey = (tenant: { _id: ObjectId }) =>
  `console:connections:${tenant._id.toHexString()}`;

const TRUST = {
  claimAndDomain: "CLAIM_AND_DOMAIN",
  domain: "DOMAIN",
} as const;
const TRUST_IN = {
  CLAIM_AND_DOMAIN: "claimAndDomain",
  DOMAIN: "domain",
} as const;
const AUTH = { post: "POST", basic: "BASIC" } as const;
const AUTH_IN = { POST: "post", BASIC: "basic" } as const;

const shape = (doc: ConnectionDoc, issuer: string) => ({
  id: doc.connectionId,
  redirectUri: callbackUrlOf(issuer, doc.connectionId),
  name: doc.name,
  issuer: doc.issuer,
  clientId: doc.clientId,
  clientAuthentication:
    doc.clientAuthentication === null ? null : AUTH[doc.clientAuthentication],
  idTokenSignedResponseAlg: doc.idTokenSignedResponseAlg as never,
  scopes: doc.scopes,
  emailTrust: TRUST[doc.emailTrust],
  claims: {
    email: doc.claims.email ?? null,
    emailVerified: doc.claims.emailVerified ?? null,
    name: doc.claims.name ?? null,
    picture: doc.claims.picture ?? null,
  },
  domains: doc.domains.map((entry) => ({
    domain: entry.domain,
    txtName: txtNameOf(entry.domain),
    txtToken: entry.txtToken,
    verified: entry.verifiedAt !== null,
    verifiedAt: entry.verifiedAt,
    checkedAt: entry.checkedAt,
  })),
  requireSso: doc.requireSso,
  jit: doc.jit,
  showButton: doc.showButton,
  upstreamMfa: doc.upstreamMfa,
  enabled: doc.enabled,
  revision: doc.revision,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const claimsIn = (
  claims:
    | {
        email?: string | null;
        emailVerified?: string | null;
        name?: string | null;
        picture?: string | null;
      }
    | null
    | undefined,
) =>
  claims === null || claims === undefined
    ? undefined
    : (Object.fromEntries(
        Object.entries(claims).filter(([, value]) => typeof value === "string"),
      ) as Record<string, string>);

export const connectionsModule: Resolvers = {
  Query: {
    connections: async (_, { tenantId }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const issuer = await issuerFor(tenant);
      return (await connections.list(tenant._id.toHexString())).map((doc) =>
        shape(doc, issuer),
      );
    },
    connection: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const found = await connections.find(tenant._id.toHexString(), id);
      return found === undefined ? null : shape(found, await issuerFor(tenant));
    },
    checkConnection: async (_, { tenantId, input }, ctx) => {
      await catalogTenant(ctx, tenantId);
      return refusing(() =>
        issuerChecker({
          connectionId: input.id,
          issuer: input.issuer,
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          clientAuthentication:
            input.clientAuthentication == null
              ? null
              : AUTH_IN[input.clientAuthentication],
          idTokenSignedResponseAlg: input.idTokenSignedResponseAlg ?? null,
          scopes: input.scopes ?? null,
          emailTrust: TRUST_IN[input.emailTrust ?? "CLAIM_AND_DOMAIN"],
          claims: claimsIn(input.claims) ?? {},
          domains: [],
          revision: 1,
        }),
      );
    },
  },
  Mutation: {
    createConnection: async (_, { tenantId, input }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const stored = await tenantsService.find(tenant._id.toHexString());
      const quota =
        stored === undefined ? 0 : effectiveQuotas(stored).connections;
      const created = await ctx.exclusive(connectionsKey(tenant), () =>
        refusing(() =>
          connections.create(
            tenant._id.toHexString(),
            {
              ...input,
              id: input.id,
              clientAuthentication:
                input.clientAuthentication == null
                  ? null
                  : AUTH_IN[input.clientAuthentication],
              emailTrust:
                input.emailTrust == null
                  ? undefined
                  : TRUST_IN[input.emailTrust],
              claims: claimsIn(input.claims),
              requireSso: input.requireSso ?? undefined,
              jit: input.jit ?? undefined,
              showButton: input.showButton ?? undefined,
              enabled: input.enabled ?? undefined,
            },
            quota,
          ),
        ),
      );
      await ctx.audit(
        "connection.create",
        target(tenant._id, created.connectionId),
      );
      return shape(created, await issuerFor(tenant));
    },
    updateConnection: async (_, { tenantId, id, input }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const updated = await ctx.exclusive(connectionsKey(tenant), () =>
        refusing(() =>
          connections.update(tenant._id.toHexString(), id, {
            ...(input.name == null ? {} : { name: input.name }),
            ...(input.issuer == null ? {} : { issuer: input.issuer }),
            ...(input.clientId == null ? {} : { clientId: input.clientId }),
            ...(input.clientAuthentication === undefined
              ? {}
              : {
                  clientAuthentication:
                    input.clientAuthentication === null
                      ? null
                      : AUTH_IN[input.clientAuthentication],
                }),
            ...(input.idTokenSignedResponseAlg === undefined
              ? {}
              : { idTokenSignedResponseAlg: input.idTokenSignedResponseAlg }),
            ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
            ...(input.emailTrust == null
              ? {}
              : { emailTrust: TRUST_IN[input.emailTrust] }),
            ...(input.claims === undefined ? {} : { claims: input.claims }),
            ...(input.requireSso == null
              ? {}
              : { requireSso: input.requireSso }),
            ...(input.jit == null ? {} : { jit: input.jit }),
            ...(input.showButton == null
              ? {}
              : { showButton: input.showButton }),
            ...(input.upstreamMfa === undefined
              ? {}
              : { upstreamMfa: input.upstreamMfa }),
            ...(input.enabled == null ? {} : { enabled: input.enabled }),
          }),
        ),
      );
      await ctx.audit("connection.update", target(tenant._id, id));
      return shape(updated, await issuerFor(tenant));
    },
    setConnectionSecret: async (_, { tenantId, id, clientSecret }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const updated = await ctx.exclusive(connectionsKey(tenant), () =>
        refusing(() =>
          connections.setSecret(tenant._id.toHexString(), id, clientSecret),
        ),
      );
      await ctx.audit("connection.setSecret", target(tenant._id, id));
      return shape(updated, await issuerFor(tenant));
    },
    deleteConnection: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const removed = await ctx.exclusive(connectionsKey(tenant), () =>
        refusing(() => connections.delete(tenant._id.toHexString(), id)),
      );
      // Recorded on a repeat too (it may be the event the first run missed).
      await ctx.audit("connection.delete", target(tenant._id, id));
      return removed;
    },
    addConnectionDomain: async (_, { tenantId, id, domain }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const updated = await ctx.exclusive(connectionsKey(tenant), () =>
        refusing(() =>
          connections.addDomain(tenant._id.toHexString(), id, domain),
        ),
      );
      await ctx.audit("connection.addDomain", target(tenant._id, id));
      return shape(updated, await issuerFor(tenant));
    },
    verifyConnectionDomain: async (_, { tenantId, id, domain }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const checked = await ctx.exclusive(connectionsKey(tenant), () =>
        refusing(() =>
          connections.verifyDomain(tenant._id.toHexString(), id, domain),
        ),
      );
      await ctx.audit("connection.verifyDomain", target(tenant._id, id));
      return {
        connection: shape(checked.connection, await issuerFor(tenant)),
        verified: checked.verified,
      };
    },
    removeConnectionDomain: async (_, { tenantId, id, domain }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const updated = await ctx.exclusive(connectionsKey(tenant), () =>
        refusing(() =>
          connections.removeDomain(tenant._id.toHexString(), id, domain),
        ),
      );
      await ctx.audit("connection.removeDomain", target(tenant._id, id));
      return shape(updated, await issuerFor(tenant));
    },
  },
};
export { connectionsModule as connections };
