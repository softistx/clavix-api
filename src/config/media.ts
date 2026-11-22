import type { MediaPorts } from "@/http/media-mount";
import { AvatarsService } from "@/modules/media";
import { tenantJanusById } from "./console";
import { mediaStore } from "./media-objects";
import { avatarThrottle } from "./throttle";
import { janusIssuers } from "./users";

/** The picture service: a user's picture in janus, over the request's tenant. */
export const avatarsService = new AvatarsService({ issuers: janusIssuers });

/** The picture routes' ports, bound once (`appPorts`). */
export const mediaPorts: MediaPorts = {
  store: mediaStore,
  avatars: avatarsService,
  issuers: janusIssuers,
  janusOf: tenantJanusById,
  throttle: avatarThrottle,
};
