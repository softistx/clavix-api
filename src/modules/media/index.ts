// The module's import surface (media: the profile picture). Imported by file
// where a config module would make a cycle: `media.resolver`
// (`modules/index.ts`) and `media.errors` (`i18n/codes.ts`), and by `media.utils`
// (`users.tenant-auth.ts`) and `media.throttle` (`config/redis*.ts`), which the
// barrel would loop back to through `config/*`.

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
  AvatarRecorder,
  AvatarsPorts,
  AvatarTarget,
  AvatarWrite,
} from "./media.types";
export { tenantFolder } from "./media.utils";
export {
  AvatarAccessService,
  AvatarObjectsService,
  AvatarsService,
} from "./services";
