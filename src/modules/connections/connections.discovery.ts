import { SocialError } from "@softistx/janus";
import {
  createMemoryConnections,
  oidcConnections,
} from "@softistx/janus-social";
import { ConnectionError } from "./connections.errors";
import { checked, type RecordParts } from "./connections.record";

/** What a successful check tells the admin. */
export interface IssuerSummary {
  issuer: string;
  authorizationEndpoint: string;
}

/**
 * The port of the "check this connection" action: reads the issuer's
 * discovery document through janus's guarded fetch (https only, no private
 * address, no redirect, bounded). Injected, so specs never touch the network.
 */
export type IssuerChecker = (parts: RecordParts) => Promise<IssuerSummary>;

/** A reason janus gives for a host it could not reach; every other one is a refusal. */
const UNREACHABLE = new Set(["unreachable", "timeout"]);

/**
 * Validates the candidate record (`checkConnection`) and asks janus for its
 * authorization URL, which reads the discovery document. The redirect URI is
 * a placeholder: nothing is sent to it.
 */
export const discoverIssuer: IssuerChecker = async (parts) => {
  const record = checked({ ...parts, domains: [] });
  const placeholder = { ...record, domains: ["placeholder.example.com"] };
  const { resolve } = oidcConnections({
    source: createMemoryConnections([placeholder]),
    redirectUri: "https://clavix.invalid/sign-in/sso/callback",
  });
  try {
    const provider = await resolve(record.id);
    if (provider === null) {
      throw new ConnectionError(
        "ISSUER_REFUSED",
        "The issuer was refused",
        "issuer",
      );
    }
    const url = await provider.authorizationUrl({
      state: "check",
      nonce: "check",
      codeVerifier: "c".repeat(43),
      stepUp: null,
    });
    return {
      issuer: record.issuer,
      authorizationEndpoint: `${url.origin}${url.pathname}`,
    };
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    if (error instanceof SocialError) {
      const reason = String((error as { reason?: unknown }).reason ?? "");
      throw new ConnectionError(
        UNREACHABLE.has(reason) ? "ISSUER_UNREACHABLE" : "ISSUER_REFUSED",
        UNREACHABLE.has(reason)
          ? "The issuer could not be reached"
          : "The issuer was refused: it must be a public https address answering a discovery document",
        "issuer",
      );
    }
    throw error;
  }
};
