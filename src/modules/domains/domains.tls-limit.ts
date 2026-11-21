import { defineRateLimit } from "@softistx/redis";

// The TLS ask is called by the proxy for every handshake of a host it has no
// certificate for, and any client can make it do so. One global bucket (GCRA,
// per minute) bounds the asks that are answered yes, so the certificates the
// proxy goes on to order. It is spent after the lookup: an unknown name is
// refused without touching it (each such ask is one indexed read).
export const tlsAskLimit = (perMinute: number) =>
  defineRateLimit({
    name: "tls-ask",
    key: (who: { scope: string }) => who.scope,
    limit: perMinute,
    per: 60_000,
  });

/**
 * Spends one ask from `consume`. It FAILS CLOSED: when the limiter cannot
 * answer (Redis down) the ask of a known host is refused (429) and a warning
 * is logged, so no certificate is ordered uncounted. Caddy retries, and
 * certificates already issued keep serving.
 */
export const tlsAskGate =
  (
    consume: () => Promise<{ allowed: boolean }>,
    log: (message: string) => void,
  ) =>
  async (): Promise<boolean> => {
    try {
      return (await consume()).allowed;
    } catch (error) {
      log(`tls ask: rate limit unavailable, refusing (${String(error)})`);
      return false;
    }
  };
