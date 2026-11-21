import { describe, expect, test } from "bun:test";
import { env } from "./env";
import {
  auditExportFromEnv,
  consoleFromEnv,
  deviceFromEnv,
  metadataFromEnv,
  passkeysFromEnv,
  registerFromEnv,
  signInFromEnv,
  ssoFromEnv,
  verificationFromEnv,
} from "./redis-limits";

describe("the limits read from the environment", () => {
  test("each reads the variables of its own limit", () => {
    expect(signInFromEnv().ipLimit).toBe(env.CLAVIX_CODE_IP_LIMIT);
    expect(passkeysFromEnv().tenantWindowSeconds).toBe(
      env.CLAVIX_PASSKEY_TENANT_WINDOW_SECONDS,
    );
    expect(verificationFromEnv().userLimit).toBe(env.CLAVIX_VERIFY_USER_LIMIT);
    expect(deviceFromEnv().ipWindowSeconds).toBe(
      env.CLAVIX_DEVICE_IP_WINDOW_SECONDS,
    );
    expect(registerFromEnv().tenantLimit).toBe(
      env.CLAVIX_REGISTER_TENANT_LIMIT,
    );
    expect(metadataFromEnv().ipLimit).toBe(env.CLAVIX_METADATA_IP_LIMIT);
    expect(auditExportFromEnv()).toEqual({
      limit: env.CLAVIX_EXPORT_TENANT_LIMIT,
      windowSeconds: env.CLAVIX_EXPORT_TENANT_WINDOW_SECONDS,
    });
    expect(ssoFromEnv().tenantLimit).toBe(env.CLAVIX_SSO_TENANT_LIMIT);
    expect(consoleFromEnv().inviteCallerLimit).toBe(
      env.CLAVIX_INVITE_CALLER_LIMIT,
    );
  });
});
