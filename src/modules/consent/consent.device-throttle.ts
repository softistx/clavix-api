import {
  type BoundLimits,
  createUserThrottle,
  retryAfterSeconds,
  type UserBoundLimits,
  type UserLimitConfig,
  type UserThrottle,
  userAndTenantLimits,
} from "@/http/throttle/core";
import { deviceCodeThrottled } from "./consent.errors";

export type DeviceLimitConfig = UserLimitConfig;
export type DeviceThrottle = UserThrottle;

// The three limits on the device verification page's lookups
// (`oauthDeviceRequest`, `approveOAuthDeviceRequest`, `denyOAuthDeviceRequest`):
// per signed-in user, per client address and tenant, and per tenant. A user
// code is short and typed by hand, so the guesses are the attack
// (`userAndTenantLimits`).
export const deviceLimits = (config: DeviceLimitConfig) => {
  const { ip, tenant, user } = userAndTenantLimits("device", config);
  return { deviceIp: ip, deviceTenant: tenant, deviceUser: user };
};

/**
 * The user first (a refused user spends no address or tenant budget), then the
 * address and the tenant. Every lookup counts, hit or miss: janus's hook runs
 * before the store is read. Redis down or slow: the request goes through,
 * logged.
 */
export function createDeviceThrottle(
  limits: {
    deviceUser: UserBoundLimits["user"];
    deviceIp: BoundLimits["ip"];
    deviceTenant: BoundLimits["tenant"];
  },
  log?: (message: string) => void,
): DeviceThrottle {
  return createUserThrottle(
    {
      user: limits.deviceUser,
      ip: limits.deviceIp,
      tenant: limits.deviceTenant,
    },
    (result) => deviceCodeThrottled(retryAfterSeconds(result)),
    "device code limits",
    log,
  );
}
