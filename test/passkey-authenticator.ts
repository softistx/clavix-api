/**
 * A software authenticator: ES256 keys on WebCrypto, `none` attestation, and
 * the browser's JSON (`toJSON()`) for what it registers and signs. Every knob
 * a refusal case turns is an option.
 */

import { type Cbor, encode } from "./passkey-cbor";

export const RP_ID = "example.com";
export const ORIGIN = "https://app.example.com";
export const AAGUID = "00112233-4455-6677-8899-aabbccddeeff";
const AAGUID_BYTES = Uint8Array.from(
  Buffer.from(AAGUID.replaceAll("-", ""), "hex"),
);

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

export interface Ceremony {
  readonly challenge: string;
  readonly origin?: string;
  readonly rpId?: string;
  readonly type?: string;
  readonly userPresent?: boolean;
  readonly userVerified?: boolean;
  readonly backupEligible?: boolean;
  readonly backedUp?: boolean;
  readonly counter?: number;
  /** The user handle a discoverable assertion carries, base64url; none by default. */
  readonly userHandle?: string;
  /** The attestation format; `none` by default. */
  readonly attestation?: string;
}

function flags(ceremony: Ceremony, attested: boolean): number {
  return (
    ((ceremony.userPresent ?? true) ? 0x01 : 0) |
    ((ceremony.userVerified ?? true) ? 0x04 : 0) |
    (ceremony.backupEligible ? 0x08 : 0) |
    (ceremony.backedUp ? 0x10 : 0) |
    (attested ? 0x40 : 0)
  );
}

function counterBytes(counter: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, counter);
  return new Uint8Array(view.buffer);
}

function join(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

/** ECDSA r||s (WebCrypto) to the DER the library verifies. */
function toDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let body: Uint8Array = bytes.slice(start);
    if ((body[0] ?? 0) & 0x80) body = join(Uint8Array.of(0), body);
    return join(Uint8Array.of(0x02, body.length), body);
  };
  const body = join(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return join(Uint8Array.of(0x30, body.length), body);
}

export interface SoftwareAuthenticator {
  readonly credentialId: string;
  /** The COSE public key, base64url, as the verifier stores it. */
  readonly publicKey: string;
  register(ceremony: Ceremony): Promise<unknown>;
  assert(ceremony: Ceremony): Promise<unknown>;
}

/** A fresh ES256 key pair and its public half as COSE. */
async function newKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = encode(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x ?? "", "base64url")],
      [-3, Buffer.from(jwk.y ?? "", "base64url")],
    ]),
  );
  return { privateKey: pair.privateKey, cose };
}

const clientData = (ceremony: Ceremony, fallbackType: string) =>
  new TextEncoder().encode(
    JSON.stringify({
      type: ceremony.type ?? fallbackType,
      challenge: ceremony.challenge,
      origin: ceremony.origin ?? ORIGIN,
      crossOrigin: false,
    }),
  );

const rpIdHash = (ceremony: Ceremony) =>
  sha256(new TextEncoder().encode(ceremony.rpId ?? RP_ID));

/** The credential the browser hands over, with the `response` of the ceremony. */
const credential = (
  id: string,
  response: Record<string, unknown>,
  extra = {},
) => ({
  id,
  rawId: id,
  type: "public-key",
  clientExtensionResults: {},
  ...extra,
  response,
});

async function registration(
  ceremony: Ceremony,
  credentialBytes: Uint8Array,
  cose: Uint8Array,
) {
  const authData = join(
    await rpIdHash(ceremony),
    Uint8Array.of(flags(ceremony, true)),
    counterBytes(ceremony.counter ?? 0),
    AAGUID_BYTES,
    Uint8Array.of(0, credentialBytes.length),
    credentialBytes,
    cose,
  );
  const attestation = encode(
    new Map<Cbor, Cbor>([
      ["fmt", ceremony.attestation ?? "none"],
      ["attStmt", new Map<Cbor, Cbor>()],
      ["authData", authData],
    ]),
  );
  return credential(
    b64(credentialBytes),
    {
      clientDataJSON: b64(clientData(ceremony, "webauthn.create")),
      attestationObject: b64(attestation),
      transports: ["internal", "hybrid"],
    },
    { authenticatorAttachment: "platform" },
  );
}

async function assertion(
  ceremony: Ceremony,
  credentialBytes: Uint8Array,
  privateKey: CryptoKey,
) {
  const authData = join(
    await rpIdHash(ceremony),
    Uint8Array.of(flags(ceremony, false)),
    counterBytes(ceremony.counter ?? 1),
  );
  const data = clientData(ceremony, "webauthn.get");
  const signed = join(authData, await sha256(data));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      signed as BufferSource,
    ),
  );
  return credential(b64(credentialBytes), {
    clientDataJSON: b64(data),
    authenticatorData: b64(authData),
    signature: b64(toDer(signature)),
    ...(ceremony.userHandle === undefined
      ? {}
      : { userHandle: ceremony.userHandle }),
  });
}

export async function softwareAuthenticator(
  credentialBytes = crypto.getRandomValues(new Uint8Array(16)),
): Promise<SoftwareAuthenticator> {
  const { privateKey, cose } = await newKey();
  return {
    credentialId: b64(credentialBytes),
    publicKey: b64(cose),
    register: (ceremony) => registration(ceremony, credentialBytes, cose),
    assert: (ceremony) => assertion(ceremony, credentialBytes, privateKey),
  };
}
