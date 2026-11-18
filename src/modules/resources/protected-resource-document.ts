import { protectedResource } from "@softistx/janus-oauth";

/** The DPoP proof algorithms every tenant's authorization server accepts (`building.ts` and the documents agree). */
export const DPOP_ALGORITHMS = ["ES256", "EdDSA"] as const;

export interface ProtectedResourceDocumentInput {
  /** The resource's URI, as registered (the `aud` of its tokens). */
  uri: string;
  /** The tenant's issuer, the one tokens carry. */
  issuer: string;
  /** The names of the resource's own scopes. */
  scopes: readonly string[];
  /** The tenant requires DPoP (`oauthPolicy.dpop.required`). */
  dpopRequired: boolean;
}

/**
 * The RFC 9728 document the resource server serves at `metadataUrl`, built
 * with janus's `protectedResource` so the console shows exactly what janus's
 * handler answers. Clavix hosts no copy (D13): the document belongs to the
 * resource's own origin (RFC 9728 §3.3). The tenant's DPoP policy is announced
 * only when it requires proofs; a tenant that does not require them still
 * accepts them from a client that sends one.
 */
export async function protectedResourceDocument(
  input: ProtectedResourceDocumentInput,
): Promise<{ metadataUrl: string; metadata: string }> {
  const resource = protectedResource({
    resource: input.uri,
    issuer: input.issuer,
    scopes: input.scopes,
    ...(input.dpopRequired
      ? { dpop: { algorithms: DPOP_ALGORITHMS, required: true } }
      : {}),
  });
  const response = await resource.metadata(new Request(resource.metadataUrl));
  return { metadataUrl: resource.metadataUrl, metadata: await response.text() };
}
