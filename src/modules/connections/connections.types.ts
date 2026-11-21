import type { OidcConnectionsOptions } from "@softistx/janus-social";
import type { TxtResolver } from "@/modules/domains";
import type { ConnectionEmailTrust } from "./connections.model";

/** The accounts linked through a connection, counted by the identity store (`CONNECTION_IN_USE`). */
export type LinkCounter = (
  tenantId: string,
  connectionId: string,
) => Promise<number>;

export interface ClaimsInput {
  email?: string | null | undefined;
  emailVerified?: string | null | undefined;
  name?: string | null | undefined;
  picture?: string | null | undefined;
}

export interface ConnectionInput {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  clientAuthentication?: "post" | "basic" | null | undefined;
  idTokenSignedResponseAlg?: string | null | undefined;
  scopes?: readonly string[] | null | undefined;
  emailTrust?: ConnectionEmailTrust | undefined;
  claims?: ClaimsInput | null | undefined;
  requireSso?: boolean | undefined;
  jit?: boolean | undefined;
  showButton?: boolean | undefined;
  upstreamMfa?: { acr: string } | null | undefined;
  enabled?: boolean | undefined;
}

/** Fields left out stay as they are; `null` clears an optional one. */
export type ConnectionPatch = Partial<
  Omit<ConnectionInput, "id" | "clientSecret">
>;

/** How the guard resolves an identity provider's host; `node:dns` by default. */
export type HostResolver = NonNullable<OidcConnectionsOptions["resolveHost"]>;
export type ConnectionsFetch = NonNullable<OidcConnectionsOptions["fetch"]>;

export interface ConnectionsOptions {
  txt: TxtResolver;
  links: LinkCounter;
  /** Reads the issuer's metadata: whether it advertises the `iss` response parameter (RFC 9207). Absent: never pinned. */
  advertisesIss?: (issuer: string) => Promise<boolean>;
  now?: () => Date;
  log?: (message: string) => void;
}
