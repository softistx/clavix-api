import { MediaRefusal } from "@softistx/alxia-media";
import {
  type BoundLimits,
  createUserThrottle,
  retryAfterSeconds,
  type UserBoundLimits,
  type UserLimitConfig,
  type UserThrottle,
  userAndTenantLimits,
} from "@/http/throttle/core";

export type AvatarLimitConfig = UserLimitConfig;
export type AvatarThrottle = UserThrottle;

// The three limits on a picture upload, which stores an object for whoever
// asks: per signed-in user, per client address and tenant, and per tenant
// (`userAndTenantLimits`).
export const avatarLimits = (config: AvatarLimitConfig) => {
  const { ip, tenant, user } = userAndTenantLimits("avatar", config);
  return { avatarIp: ip, avatarTenant: tenant, avatarUser: user };
};

/**
 * The user first (a refused user spends no address or tenant budget), then the
 * address and the tenant. A refusal is the media routes' own `throttled` (429
 * with `Retry-After`). Redis down or slow: the upload goes through, logged.
 */
export function createAvatarThrottle(
  limits: {
    avatarUser: UserBoundLimits["user"];
    avatarIp: BoundLimits["ip"];
    avatarTenant: BoundLimits["tenant"];
  },
  log: (message: string) => void,
): AvatarThrottle {
  return createUserThrottle(
    {
      user: limits.avatarUser,
      ip: limits.avatarIp,
      tenant: limits.avatarTenant,
    },
    (result) =>
      new MediaRefusal("throttled", { retryAfter: retryAfterSeconds(result) }),
    "avatar upload limits",
    log,
  );
}
