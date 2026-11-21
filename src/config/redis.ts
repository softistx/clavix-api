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
import { agentsPrune } from "@/modules/agents/prune.queue";
import { auditRetention } from "@/modules/audit/retention.queue";
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
import { domainRecheck } from "@/modules/domains/domains.recheck-queue";
import { tlsAskLimit } from "@/modules/domains/domains.tls-limit";
import { keyRotation } from "@/modules/keys/queue";
import {
  type PasskeyLimitConfig,
  passkeyLimits,
} from "@/modules/passkeys/passkeys.throttle";
import { ssoLimits } from "@/modules/sign-in-methods";
import { tenantPurge } from "@/modules/tenants/tenants.purge-queue";
import { monthlyActiveUsers } from "@/modules/usage/mau";
import { webhookSecretsPrune } from "@/modules/webhooks/webhooks.secrets-prune-queue";
import {
  type MetadataLimitConfig,
  metadataLimits,
  type RegisterLimitConfig,
  registerLimits,
} from "@/oauth/register-throttle";
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
  verification: VerificationLimitConfig = {
    userLimit: env.CLAVIX_VERIFY_USER_LIMIT,
    userWindowSeconds: env.CLAVIX_VERIFY_USER_WINDOW_SECONDS,
    ipLimit: env.CLAVIX_VERIFY_IP_LIMIT,
    ipWindowSeconds: env.CLAVIX_VERIFY_IP_WINDOW_SECONDS,
    tenantLimit: env.CLAVIX_VERIFY_TENANT_LIMIT,
    tenantWindowSeconds: env.CLAVIX_VERIFY_TENANT_WINDOW_SECONDS,
  },
  device: DeviceLimitConfig = {
    userLimit: env.CLAVIX_DEVICE_USER_LIMIT,
    userWindowSeconds: env.CLAVIX_DEVICE_USER_WINDOW_SECONDS,
    ipLimit: env.CLAVIX_DEVICE_IP_LIMIT,
    ipWindowSeconds: env.CLAVIX_DEVICE_IP_WINDOW_SECONDS,
    tenantLimit: env.CLAVIX_DEVICE_TENANT_LIMIT,
    tenantWindowSeconds: env.CLAVIX_DEVICE_TENANT_WINDOW_SECONDS,
  },
  register: RegisterLimitConfig = {
    ipLimit: env.CLAVIX_REGISTER_IP_LIMIT,
    ipWindowSeconds: env.CLAVIX_REGISTER_IP_WINDOW_SECONDS,
    tenantLimit: env.CLAVIX_REGISTER_TENANT_LIMIT,
    tenantWindowSeconds: env.CLAVIX_REGISTER_TENANT_WINDOW_SECONDS,
  },
  metadata: MetadataLimitConfig = {
    ipLimit: env.CLAVIX_METADATA_IP_LIMIT,
    ipWindowSeconds: env.CLAVIX_METADATA_IP_WINDOW_SECONDS,
    tenantLimit: env.CLAVIX_METADATA_TENANT_LIMIT,
    tenantWindowSeconds: env.CLAVIX_METADATA_TENANT_WINDOW_SECONDS,
  },
  auditExport: ExportLimitConfig = {
    limit: env.CLAVIX_EXPORT_TENANT_LIMIT,
    windowSeconds: env.CLAVIX_EXPORT_TENANT_WINDOW_SECONDS,
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
      queues: {
        keyRotation,
        tenantPurge,
        domainRecheck,
        agentsPrune,
        grantsRevoke,
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
        ...ssoLimits({
          ipLimit: env.CLAVIX_SSO_IP_LIMIT,
          ipWindowSeconds: env.CLAVIX_SSO_IP_WINDOW_SECONDS,
          tenantLimit: env.CLAVIX_SSO_TENANT_LIMIT,
          tenantWindowSeconds: env.CLAVIX_SSO_TENANT_WINDOW_SECONDS,
        }),
        ...consoleLimits({
          testEndpointLimit: env.CLAVIX_WEBHOOK_TEST_ENDPOINT_LIMIT,
          testTenantLimit: env.CLAVIX_WEBHOOK_TEST_TENANT_LIMIT,
          testWindowSeconds: env.CLAVIX_WEBHOOK_TEST_WINDOW_SECONDS,
          inviteCallerLimit: env.CLAVIX_INVITE_CALLER_LIMIT,
          inviteCallerWindowSeconds: env.CLAVIX_INVITE_CALLER_WINDOW_SECONDS,
          inviteTenantLimit: env.CLAVIX_INVITE_TENANT_LIMIT,
          inviteTenantWindowSeconds: env.CLAVIX_INVITE_TENANT_WINDOW_SECONDS,
        }),
        tlsAsk: tlsAskLimit(env.CLAVIX_TLS_ASK_LIMIT),
      },
      background: {
        onDown: () => log("redis unavailable: tenant cache degraded"),
        onUp: () => log("redis is back"),
      },
    }),
  );
  // The connection the webhook queue takes (`createRedisWebhookQueue`): it
  // reads `client` only, and the client is closed by `close` below.
  const connection: RedisConnection = {
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
  env.REDIS_URL === undefined ? undefined : await openAppRedis(env.REDIS_URL);
