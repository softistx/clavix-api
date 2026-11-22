import { callbackUrlOf } from "@/modules/sign-in-methods";
import type { ConnectionDoc } from "../connections.model";
import { AUTH, TRUST } from "./enums.utils";
import { txtNameOf } from "./record.utils";

/** A connection as the console shows it, its redirect URI built on `issuer`. */
export const connectionShape = (doc: ConnectionDoc, issuer: string) => ({
  id: doc.connectionId,
  redirectUri: callbackUrlOf(issuer, doc.connectionId),
  name: doc.name,
  issuer: doc.issuer,
  clientId: doc.clientId,
  clientAuthentication:
    doc.clientAuthentication === null ? null : AUTH[doc.clientAuthentication],
  idTokenSignedResponseAlg: doc.idTokenSignedResponseAlg,
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
