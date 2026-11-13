import { defineRateLimit } from "@softistx/redis";

// The TLS ask is called by the proxy for every handshake of an unknown host,
// and any client can make it do so: one global bucket (GCRA, per minute) keeps
// a flood of unknown names from reaching Mongo.
export const tlsAskLimit = (perMinute: number) =>
  defineRateLimit({
    name: "tls-ask",
    key: (who: { scope: string }) => who.scope,
    limit: perMinute,
    per: 60_000,
  });

/**
 * Spends one ask from `consume`. It FAILS CLOSED: when the limiter cannot
 * answer (Redis down) the ask is refused (429) and a warning is logged, so a
 * flood of unknown names cannot reach Mongo while the bucket is out. Caddy
 * retries, and certificates already issued keep serving.
 */
export const tlsAskGate =
  (
    consume: () => Promise<{ allowed: boolean }>,
    log: (message: string) => void = (message) => console.warn(message),
  ) =>
  async (): Promise<boolean> => {
    try {
      return (await consume()).allowed;
    } catch (error) {
      log(`tls ask: rate limit unavailable, refusing (${String(error)})`);
      return false;
    }
  };
