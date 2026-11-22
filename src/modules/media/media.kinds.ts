import {
  defineMediaKind,
  isMediaRefusal,
  type MediaContext,
} from "@softistx/alxia-media";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import {
  AVATAR_CACHE_CONTROL,
  AVATAR_KIND,
  AVATAR_MAX_BYTES,
  AVATAR_TYPES,
} from "./media.rules";
import type { AvatarThrottle } from "./media.throttle";
import type { AvatarAccessService } from "./services/avatar-access.service";

/** What the avatar kind reads of the request's context beyond alxia's own. */
export interface AvatarRequires {
  tenant(): Promise<ResolvedTenant | null>;
  avatarThrottle: AvatarThrottle;
}

/**
 * The profile picture: a PNG, JPEG or WebP of at most 1 MiB, throttled on
 * write, written by the user themselves or by a tenant admin
 * (`AvatarAccessService`), readable by anyone who has its key (a random UUID),
 * served immutable.
 */
export function avatarKind(access: AvatarAccessService) {
  const target = (ctx: MediaContext<AvatarRequires>) => access.targetOf(ctx);
  return defineMediaKind<AvatarRequires>({
    name: AVATAR_KIND,
    accept: AVATAR_TYPES,
    maxBytes: AVATAR_MAX_BYTES,
    public: true,
    cacheControl: AVATAR_CACHE_CONTROL,
    authorizeWrite: async (ctx) => {
      await target(ctx);
      return true;
    },
    throttle: async (ctx) => {
      const { tenantId, userId } = await target(ctx);
      try {
        await ctx.avatarThrottle.check({ tenantId, userId, ip: ctx.ip });
        return true;
      } catch (error) {
        if (!isMediaRefusal(error)) throw error;
        return error.details.retryAfter ?? false;
      }
    },
  });
}
