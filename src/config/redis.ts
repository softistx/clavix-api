import {
  bindUniqueCounter,
  defineRedis,
  openRedis,
  type RedisConnection,
} from "@softistx/redis";
import { RedisClient } from "bun";
import {
  type ExportLimitConfig,
  exportLimits,
} from "@/console/audit-export/throttle";
import { consoleLimits } from "@/console/budgets";
import { agentsPrune } from "@/modules/agents/agents.prune-queue";
import { auditRetention } from "@/modules/audit/audit.retention-queue";
import {
  type SignInLimitConfig,
  signInLimits,
} from "@/modules/auth/auth.throttle";
import {
  type VerificationLimitConfig,
  verificationLimits,
} from "@/modules/auth/auth.verification-throttle";
import {
  type DeviceLimitConfig,
  deviceLimits,
} from "@/modules/consent/consent.device-throttle";
import { grantsRevoke } from "@/modules/consent/consent.queue";
import { tlsAskLimit } from "@/modules/domains";
import { domainRecheck } from "@/modules/domains/domains.recheck-queue";
import { keyRotation } from "@/modules/keys/keys.queue";
import {
  type AvatarLimitConfig,
  avatarLimits,
} from "@/modules/media/media.throttle";
import {
  type PasskeyLimitConfig,
  passkeyLimits,
} from "@/modules/passkeys/passkeys.throttle";
import { ssoLimits } from "@/modules/sign-in-methods";
import { eraseReplaced } from "@/modules/sign-in-methods/sign-in-methods.queue";
import { tenantPurge } from "@/modules/tenants/tenants.purge-queue";
import { monthlyActiveUsers } from "@/modules/usage";
import { webhookSecretsPrune } from "@/modules/webhooks/webhooks.secrets-prune-queue";
import {
  type MetadataLimitConfig,
  metadataLimits,
  type RegisterLimitConfig,
  registerLimits,
} from "@/oauth/register-throttle";
import { tenantHostCache } from "@/tenancy/tenant-cache";
import { env } from "./env";
import {
  auditExportFromEnv,
  avatarFromEnv,
  consoleFromEnv,
  deviceFromEnv,
  metadataFromEnv,
  passkeysFromEnv,
  registerFromEnv,
  signInFromEnv,
  ssoFromEnv,
  verificationFromEnv,
} from "./redis-limits";
import { warn } from "./runtime";

// The connection the webhook queue takes (`createRedisWebhookQueue`): it
// reads `client` only, and the client is closed by `close` of the app's Redis.
function webhookConnection(client: RedisClient): RedisConnection {
  return {
    client,
    ping: async () => {
      const started = performance.now();
      try {
        await client.send("PING", []);
        return { ok: true, latencyMs: performance.now() - started };
      } catch (error) {
        return { ok: false, error };
      }
    },
    close: async () => {},
    [Symbol.asyncDispose]: async () => {},
  };
}

// The app's Redis, for the tenant cache, at `uri`. It never waits for Redis:
// the client is handed to `openRedis` unconnected (`client`, which the package
// never closes) and connects in the background, so the API starts while Redis
// is down, and a call fails at once until it answers
// (`enableOfflineQueue: false`); the cache treats a failure as a miss.
// `close` stops the retries, then closes the client and the wiring.
export async function openAppRedis(
  uri: string,
  log: (message: string) => void,
  limits: SignInLimitConfig = signInFromEnv(),
  passkeys: PasskeyLimitConfig = passkeysFromEnv(),
  verification: VerificationLimitConfig = verificationFromEnv(),
  device: DeviceLimitConfig = deviceFromEnv(),
  register: RegisterLimitConfig = registerFromEnv(),
  metadata: MetadataLimitConfig = metadataFromEnv(),
  auditExport: ExportLimitConfig = auditExportFromEnv(),
  avatar: AvatarLimitConfig = avatarFromEnv(),
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
      queues: {
        keyRotation,
        tenantPurge,
        domainRecheck,
        agentsPrune,
        grantsRevoke,
        eraseReplaced,
        auditRetention,
        webhookSecretsPrune,
      },
      limits: {
        ...signInLimits(limits),
        ...passkeyLimits(passkeys),
        ...verificationLimits(verification),
        ...deviceLimits(device),
        ...registerLimits(register),
        ...metadataLimits(metadata),
        ...exportLimits(auditExport),
        ...avatarLimits(avatar),
        ...ssoLimits(ssoFromEnv()),
        ...consoleLimits(consoleFromEnv()),
        tlsAsk: tlsAskLimit(env.CLAVIX_TLS_ASK_LIMIT),
      },
      background: {
        onDown: () => log("redis unavailable: tenant cache degraded"),
        onUp: () => log("redis is back"),
      },
    }),
  );
  const connection = webhookConnection(client);
  return {
    ...redis,
    connection,
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
  env.REDIS_URL === undefined
    ? undefined
    : await openAppRedis(env.REDIS_URL, warn);
