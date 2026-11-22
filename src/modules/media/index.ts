// The module's import surface (media: the profile picture). Imported by file
// where a config module would make a cycle: `media.resolver`
// (`modules/index.ts`) and `media.errors` (`i18n/codes.ts`).

export { adminQueryOf, crossSite } from "./media.access";
export { type MediaStore, noMediaStore, s3MediaStore } from "./media.bucket";
export { answerOf } from "./media.errors";
export { type AvatarRequires, avatarKind } from "./media.kinds";
export { AVATAR_KIND, MEDIA_PREFIX } from "./media.rules";
export {
  type AvatarLimitConfig,
  type AvatarThrottle,
  avatarLimits,
  createAvatarThrottle,
} from "./media.throttle";
export type {
  AvatarAccessPorts,
  AvatarsPorts,
  AvatarTarget,
} from "./media.types";
export { avatarObjectKey, pictureUrl, tenantFolder } from "./media.utils";
export { AvatarAccessService } from "./services/avatar-access.service";
export { AvatarsService } from "./services/avatars.service";
export { AvatarObjectsService } from "./services/objects.service";
