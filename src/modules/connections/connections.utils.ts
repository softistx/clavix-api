import type { OidcConnection } from "@softistx/janus-social";
import type { ObjectId } from "mongodb";
import type { ConnectionDoc } from "./connections.model";
import type {
  ClaimsInput,
  ConnectionInput,
  ConnectionPatch,
} from "./connections.types";

/** Where the TXT record of an e-mail domain goes: apart from the custom domains' `_clavix`. */
export const txtNameOf = (domain: string) => `_clavix-sso.${domain}`;

/** A domain as claim stores it: trimmed, lower case (janus's own normalisation of the rest). */
export const normalDomain = (domain: string) => domain.trim().toLowerCase();

/** What a sealed secret is bound to: its tenant and connection. */
export const contextOf = (tenantId: string, connectionId: string) =>
  `${tenantId}:${connectionId}`;

/** The claim names kept as stored: blank and absent ones left out. */
export const claimsOf = (claims: ClaimsInput | null | undefined) => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(claims ?? {})) {
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
};

/** The record fields an update leaves as they are, taken from the current document. */
export const nextOf = (current: ConnectionDoc, patch: ConnectionPatch) => ({
  issuer: patch.issuer ?? current.issuer,
  clientId: patch.clientId ?? current.clientId,
  clientAuthentication:
    patch.clientAuthentication === undefined
      ? current.clientAuthentication
      : patch.clientAuthentication,
  idTokenSignedResponseAlg:
    patch.idTokenSignedResponseAlg === undefined
      ? current.idTokenSignedResponseAlg
      : patch.idTokenSignedResponseAlg,
  scopes: patch.scopes === undefined ? current.scopes : patch.scopes,
  emailTrust: patch.emailTrust ?? current.emailTrust,
  claims: patch.claims === undefined ? current.claims : claimsOf(patch.claims),
  upstreamAcr:
    patch.upstreamMfa === undefined
      ? (current.upstreamMfa?.acr ?? null)
      : (patch.upstreamMfa?.acr ?? null),
});

/** The document a new connection is stored as: the checked record, the secret sealed. */
export const newDocOf = (parts: {
  id: ObjectId;
  input: ConnectionInput;
  record: OidcConnection;
  name: string;
  emailTrust: ConnectionDoc["emailTrust"];
  requireIss: boolean;
  secret: ConnectionDoc["secret"];
}) => ({
  _id: parts.id,
  connectionId: parts.record.id,
  name: parts.name,
  issuer: parts.record.issuer,
  clientId: parts.record.client.id,
  secret: parts.secret,
  clientAuthentication: parts.record.client.authentication ?? null,
  idTokenSignedResponseAlg:
    parts.record.client.idTokenSignedResponseAlg ?? null,
  scopes:
    parts.input.scopes === undefined || parts.input.scopes === null
      ? null
      : [...(parts.record.scopes ?? [])],
  emailTrust: parts.emailTrust,
  claims: claimsOf(parts.record.claims),
  domains: [],
  requireSso: parts.input.requireSso ?? true,
  jit: parts.input.jit ?? true,
  showButton: parts.input.showButton ?? false,
  upstreamMfa: parts.input.upstreamMfa ?? null,
  requireIss: parts.requireIss,
  enabled: parts.input.enabled ?? true,
  revision: 1,
});

/** The fields an update writes: the checked record, and the patch's own flags. */
export const changesOf = (parts: {
  patch: ConnectionPatch;
  current: ConnectionDoc;
  next: ReturnType<typeof nextOf>;
  record: OidcConnection;
  name: string | undefined;
  requireIss: boolean;
  enabled: boolean;
}) => ({
  ...(parts.name === undefined ? {} : { name: parts.name }),
  issuer: parts.record.issuer,
  clientId: parts.record.client.id,
  clientAuthentication: parts.record.client.authentication ?? null,
  idTokenSignedResponseAlg:
    parts.record.client.idTokenSignedResponseAlg ?? null,
  scopes: parts.next.scopes === null ? null : [...(parts.record.scopes ?? [])],
  emailTrust: parts.next.emailTrust,
  claims: claimsOf(parts.record.claims),
  ...(parts.patch.requireSso === undefined
    ? {}
    : { requireSso: parts.patch.requireSso }),
  ...(parts.patch.jit === undefined ? {} : { jit: parts.patch.jit }),
  ...(parts.patch.showButton === undefined
    ? {}
    : { showButton: parts.patch.showButton }),
  ...(parts.patch.upstreamMfa === undefined
    ? {}
    : { upstreamMfa: parts.patch.upstreamMfa }),
  requireIss: parts.requireIss,
  enabled: parts.enabled,
  revision: parts.current.revision + 1,
});
