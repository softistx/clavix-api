import type { ConnectionDoc } from "./connections.model";
import type { ClaimsInput, ConnectionPatch } from "./connections.types";

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
