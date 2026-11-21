import type {
  CheckConnectionInput,
  CreateConnectionInput,
  UpdateConnectionInput,
} from "@/generated/console/resolvers";
import { refusal } from "@/modules/tenants/tenants.console-errors";
import { fail } from "@/shared/errors";
import { ConnectionError } from "./connections.errors";
import { AUTH_IN, TRUST_IN } from "./connections.utils";

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

/** Runs a connections call, turning the service's refusals into the contract's GraphQL errors (the quota one too). */
export async function refusing<T>(call: () => Promise<T>): Promise<T> {
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

/** The claim names the caller gave, as the service takes them (non-strings dropped). */
export const claimsIn = (
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

/** What `checkConnection` asks the issuer checker, a record that is never stored. */
export const checkOf = (input: CheckConnectionInput) => ({
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
});

/** What `createConnection` hands the service: the stored names of the enums, absent fields left out. */
export const createOf = (input: CreateConnectionInput) => ({
  ...input,
  id: input.id,
  clientAuthentication:
    input.clientAuthentication == null
      ? null
      : AUTH_IN[input.clientAuthentication],
  emailTrust: input.emailTrust == null ? undefined : TRUST_IN[input.emailTrust],
  claims: claimsIn(input.claims),
  requireSso: input.requireSso ?? undefined,
  jit: input.jit ?? undefined,
  showButton: input.showButton ?? undefined,
  enabled: input.enabled ?? undefined,
});

/** What `updateConnection` hands the service: only the fields the caller sent (`null` clears an optional one). */
export const patchOf = (input: UpdateConnectionInput) => ({
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
  ...(input.requireSso == null ? {} : { requireSso: input.requireSso }),
  ...(input.jit == null ? {} : { jit: input.jit }),
  ...(input.showButton == null ? {} : { showButton: input.showButton }),
  ...(input.upstreamMfa === undefined
    ? {}
    : { upstreamMfa: input.upstreamMfa }),
  ...(input.enabled == null ? {} : { enabled: input.enabled }),
});
