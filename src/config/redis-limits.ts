import type { ExportLimitConfig } from "@/console/audit-export/throttle";
import type { SignInLimitConfig } from "@/modules/auth/auth.throttle";
import type { VerificationLimitConfig } from "@/modules/auth/auth.verification-throttle";
import type { DeviceLimitConfig } from "@/modules/consent/consent.device-throttle";
import type { PasskeyLimitConfig } from "@/modules/passkeys/passkeys.throttle";
import type {
  MetadataLimitConfig,
  RegisterLimitConfig,
} from "@/oauth/register-throttle";
import { env } from "./env";

/** The sign-in code limits, read from the environment. */
export const signInFromEnv = (): SignInLimitConfig => ({
  ipLimit: env.CLAVIX_CODE_IP_LIMIT,
  ipWindowSeconds: env.CLAVIX_CODE_IP_WINDOW_SECONDS,
  tenantLimit: env.CLAVIX_CODE_TENANT_LIMIT,
  tenantWindowSeconds: env.CLAVIX_CODE_TENANT_WINDOW_SECONDS,
});

/** The passkey limits, read from the environment. */
export const passkeysFromEnv = (): PasskeyLimitConfig => ({
  ipLimit: env.CLAVIX_PASSKEY_IP_LIMIT,
  ipWindowSeconds: env.CLAVIX_PASSKEY_IP_WINDOW_SECONDS,
  tenantLimit: env.CLAVIX_PASSKEY_TENANT_LIMIT,
  tenantWindowSeconds: env.CLAVIX_PASSKEY_TENANT_WINDOW_SECONDS,
});

/** The email verification limits, read from the environment. */
export const verificationFromEnv = (): VerificationLimitConfig => ({
  userLimit: env.CLAVIX_VERIFY_USER_LIMIT,
  userWindowSeconds: env.CLAVIX_VERIFY_USER_WINDOW_SECONDS,
  ipLimit: env.CLAVIX_VERIFY_IP_LIMIT,
  ipWindowSeconds: env.CLAVIX_VERIFY_IP_WINDOW_SECONDS,
  tenantLimit: env.CLAVIX_VERIFY_TENANT_LIMIT,
  tenantWindowSeconds: env.CLAVIX_VERIFY_TENANT_WINDOW_SECONDS,
});

/** The device grant limits, read from the environment. */
export const deviceFromEnv = (): DeviceLimitConfig => ({
  userLimit: env.CLAVIX_DEVICE_USER_LIMIT,
  userWindowSeconds: env.CLAVIX_DEVICE_USER_WINDOW_SECONDS,
  ipLimit: env.CLAVIX_DEVICE_IP_LIMIT,
  ipWindowSeconds: env.CLAVIX_DEVICE_IP_WINDOW_SECONDS,
  tenantLimit: env.CLAVIX_DEVICE_TENANT_LIMIT,
  tenantWindowSeconds: env.CLAVIX_DEVICE_TENANT_WINDOW_SECONDS,
});

/** The client registration limits, read from the environment. */
export const registerFromEnv = (): RegisterLimitConfig => ({
  ipLimit: env.CLAVIX_REGISTER_IP_LIMIT,
  ipWindowSeconds: env.CLAVIX_REGISTER_IP_WINDOW_SECONDS,
  tenantLimit: env.CLAVIX_REGISTER_TENANT_LIMIT,
  tenantWindowSeconds: env.CLAVIX_REGISTER_TENANT_WINDOW_SECONDS,
});

/** The client metadata fetch limits, read from the environment. */
export const metadataFromEnv = (): MetadataLimitConfig => ({
  ipLimit: env.CLAVIX_METADATA_IP_LIMIT,
  ipWindowSeconds: env.CLAVIX_METADATA_IP_WINDOW_SECONDS,
  tenantLimit: env.CLAVIX_METADATA_TENANT_LIMIT,
  tenantWindowSeconds: env.CLAVIX_METADATA_TENANT_WINDOW_SECONDS,
});

/** The audit export limit, read from the environment. */
export const auditExportFromEnv = (): ExportLimitConfig => ({
  limit: env.CLAVIX_EXPORT_TENANT_LIMIT,
  windowSeconds: env.CLAVIX_EXPORT_TENANT_WINDOW_SECONDS,
});

/** The enterprise sign-in limits, read from the environment. */
export const ssoFromEnv = () => ({
  ipLimit: env.CLAVIX_SSO_IP_LIMIT,
  ipWindowSeconds: env.CLAVIX_SSO_IP_WINDOW_SECONDS,
  tenantLimit: env.CLAVIX_SSO_TENANT_LIMIT,
  tenantWindowSeconds: env.CLAVIX_SSO_TENANT_WINDOW_SECONDS,
});

/** The console's webhook test and invitation limits, read from the environment. */
export const consoleFromEnv = () => ({
  testEndpointLimit: env.CLAVIX_WEBHOOK_TEST_ENDPOINT_LIMIT,
  testTenantLimit: env.CLAVIX_WEBHOOK_TEST_TENANT_LIMIT,
  testWindowSeconds: env.CLAVIX_WEBHOOK_TEST_WINDOW_SECONDS,
  inviteCallerLimit: env.CLAVIX_INVITE_CALLER_LIMIT,
  inviteCallerWindowSeconds: env.CLAVIX_INVITE_CALLER_WINDOW_SECONDS,
  inviteTenantLimit: env.CLAVIX_INVITE_TENANT_LIMIT,
  inviteTenantWindowSeconds: env.CLAVIX_INVITE_TENANT_WINDOW_SECONDS,
});
