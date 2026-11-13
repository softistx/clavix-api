import { bindUniqueCounter, defineRedis, openRedis } from "@softistx/redis";
import { RedisClient } from "bun";
import { keyRotation } from "@/keys/queue";
import { type SignInLimitConfig, signInLimits } from "@/modules/auth/throttle";
import {
  type PasskeyLimitConfig,
  passkeyLimits,
} from "@/modules/passkeys/throttle";
import { monthlyActiveUsers } from "@/modules/usage/mau";
import { tenantHostCache } from "@/tenancy/tenant-cache";
import { env } from "./env";

// The app's Redis, for the tenant cache, at `uri`. It never waits for Redis:
// the client is handed to `openRedis` unconnected (`client`, which the package
// never closes) and connects in the background, so the API starts while Redis
// is down, and a call fails at once until it answers
// (`enableOfflineQueue: false`); the cache treats a failure as a miss.
// `close` stops the retries, then closes the client and the wiring.
export async function openAppRedis(
  uri: string,
  log: (message: string) => void = (message) => console.warn(message),
  limits: SignInLimitConfig = {
    ipLimit: env.CLAVIX_CODE_IP_LIMIT,
    ipWindowSeconds: env.CLAVIX_CODE_IP_WINDOW_SECONDS,
    tenantLimit: env.CLAVIX_CODE_TENANT_LIMIT,
    tenantWindowSeconds: env.CLAVIX_CODE_TENANT_WINDOW_SECONDS,
  },
  passkeys: PasskeyLimitConfig = {
    ipLimit: env.CLAVIX_PASSKEY_IP_LIMIT,
    ipWindowSeconds: env.CLAVIX_PASSKEY_IP_WINDOW_SECONDS,
    tenantLimit: env.CLAVIX_PASSKEY_TENANT_LIMIT,
    tenantWindowSeconds: env.CLAVIX_PASSKEY_TENANT_WINDOW_SECONDS,
  },
) {
  const client = new RedisClient(uri, {
    enableOfflineQueue: false,
    connectionTimeout: 1_000,
  });
  const redis = await openRedis(
    defineRedis({
      client,
      prefix: "clavix",
      caches: { tenantHost: tenantHostCache },
      queues: { keyRotation },
      limits: { ...signInLimits(limits), ...passkeyLimits(passkeys) },
      background: {
        onDown: () => log("redis unavailable: tenant cache degraded"),
        onUp: () => log("redis is back"),
      },
    }),
  );
  return {
    ...redis,
    // Active users of the month per tenant (usage, quotas).
    mau: bindUniqueCounter(client, monthlyActiveUsers),
    close: async () => {
      await redis.close();
      client.close();
    },
  };
}

// Opened once, when this module is first imported, if REDIS_URL is set
// (required in production). Unset, outside production, there is none and
// nothing is cached.
export const redis =
  env.REDIS_URL === undefined ? undefined : await openAppRedis(env.REDIS_URL);
