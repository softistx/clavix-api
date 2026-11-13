import { defineRateLimit } from "@softistx/redis";

// The TLS ask is called by the proxy for every handshake of an unknown host,
// and any client can make it do so: one global bucket (GCRA, per minute) keeps
// a flood of unknown names from reaching Mongo. Redis down: the ask goes through.
export const tlsAskLimit = (perMinute: number) =>
  defineRateLimit({
    name: "tls-ask",
    key: (who: { scope: string }) => who.scope,
    limit: perMinute,
    per: 60_000,
  });
