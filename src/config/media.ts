import { ObjectId } from "mongodb";
import type { MediaPorts } from "@/http/media-mount";
import { AvatarsService } from "@/modules/media";
import { tenantJanusById } from "./console";
import { mediaStore } from "./media-objects";
import { profilePoliciesService } from "./profile";
import { avatarThrottle } from "./throttle";
import { janusIssuers } from "./users";

/** Whether the tenant locks the `PICTURE` profile field for self-service. */
const pictureLocked = async (tenantId: string): Promise<boolean> =>
  (await profilePoliciesService.lockedFor(new ObjectId(tenantId))).includes(
    "PICTURE",
  );

/** The picture service: a user's picture in janus, over the request's tenant. */
export const avatarsService = new AvatarsService({
  issuers: janusIssuers,
  pictureLocked,
});

/** The picture routes' ports, bound once (`appPorts`). */
export const mediaPorts: MediaPorts = {
  store: mediaStore,
  avatars: avatarsService,
  issuers: janusIssuers,
  janusOf: tenantJanusById,
  pictureLocked,
  throttle: avatarThrottle,
};
