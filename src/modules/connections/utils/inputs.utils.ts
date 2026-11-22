import type {
  CheckConnectionInput,
  CreateConnectionInput,
  UpdateConnectionInput,
} from "@/generated/console/resolvers";
import { stringsOf } from "@/shared/values";
import { AUTH_IN, TRUST_IN } from "./enums.utils";

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
) => (claims === null || claims === undefined ? undefined : stringsOf(claims));

/** What `checkConnection` asks the issuer checker, a record that is never stored. */
export const checkOf = (input: CheckConnectionInput) => ({
  connectionId: input.id,
  issuer: input.issuer,
  clientId: input.clientId,
  clientSecret: input.clientSecret,
  clientAuthentication:
    input.clientAuthentication === null ||
    input.clientAuthentication === undefined
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
    input.clientAuthentication === null ||
    input.clientAuthentication === undefined
      ? null
      : AUTH_IN[input.clientAuthentication],
  emailTrust:
    input.emailTrust === null || input.emailTrust === undefined
      ? undefined
      : TRUST_IN[input.emailTrust],
  claims: claimsIn(input.claims),
  requireSso: input.requireSso ?? undefined,
  jit: input.jit ?? undefined,
  showButton: input.showButton ?? undefined,
  enabled: input.enabled ?? undefined,
});

/** What `updateConnection` hands the service: only the fields the caller sent (`null` clears an optional one). */
export const patchOf = (input: UpdateConnectionInput) => ({
  ...(input.name === null || input.name === undefined
    ? {}
    : { name: input.name }),
  ...(input.issuer === null || input.issuer === undefined
    ? {}
    : { issuer: input.issuer }),
  ...(input.clientId === null || input.clientId === undefined
    ? {}
    : { clientId: input.clientId }),
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
  ...(input.emailTrust === null || input.emailTrust === undefined
    ? {}
    : { emailTrust: TRUST_IN[input.emailTrust] }),
  ...(input.claims === undefined ? {} : { claims: input.claims }),
  ...(input.requireSso === null || input.requireSso === undefined
    ? {}
    : { requireSso: input.requireSso }),
  ...(input.jit === null || input.jit === undefined ? {} : { jit: input.jit }),
  ...(input.showButton === null || input.showButton === undefined
    ? {}
    : { showButton: input.showButton }),
  ...(input.upstreamMfa === undefined
    ? {}
    : { upstreamMfa: input.upstreamMfa }),
  ...(input.enabled === null || input.enabled === undefined
    ? {}
    : { enabled: input.enabled }),
});
