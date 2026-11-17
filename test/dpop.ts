import { createHash } from "node:crypto";
import { jwkThumbprint } from "@softistx/janus-oauth";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/** A client's DPoP key pair (RFC 9449) and what it signs, for the specs. */
export async function createDpopKey(
  alg: "ES256" | "EdDSA" | "ES384" = "ES256",
) {
  const { privateKey, publicKey } = await generateKeyPair(alg, {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const jkt = await jwkThumbprint(jwk);
  /** A proof for `method` `url`; `accessToken` adds its `ath`, `nonce` the server's. */
  const proof = (
    method: string,
    url: string,
    extra: { accessToken?: string; nonce?: string; jti?: string } = {},
  ) =>
    new SignJWT({
      htm: method,
      htu: url,
      jti: extra.jti ?? crypto.randomUUID(),
      ...(extra.accessToken === undefined
        ? {}
        : {
            ath: createHash("sha256")
              .update(extra.accessToken)
              .digest("base64url"),
          }),
      ...(extra.nonce === undefined ? {} : { nonce: extra.nonce }),
    })
      .setProtectedHeader({ typ: "dpop+jwt", alg, jwk })
      .setIssuedAt()
      .sign(privateKey);
  return { jkt, proof };
}
export type DpopKey = Awaited<ReturnType<typeof createDpopKey>>;

/**
 * Sends a request, and once more with the server's nonce when it answers
 * `use_dpop_nonce` (a `DPoP-Nonce` header on a 400 or a 401). `send` signs a
 * new proof on each call.
 */
export async function withNonce(
  send: (nonce?: string) => Promise<Response>,
): Promise<Response> {
  const first = await send();
  const nonce = first.headers.get("dpop-nonce");
  return nonce !== null && (first.status === 400 || first.status === 401)
    ? send(nonce)
    : first;
}
