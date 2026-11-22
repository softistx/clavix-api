import { mediaPlace } from "@softistx/alxia-media";
import { AVATAR_KIND } from "./media.rules";

/** The `picture` claim: the tenant host's own `/media/avatar/<key>` (the issuer, a key is never a URL). */
export const pictureUrl = (issuer: string, key: string): string =>
  new URL(`/media/${AVATAR_KIND}/${key}`, issuer).href;

/** The folder every object of a tenant lives under (`keyPrefix`): its id. */
export const tenantFolder = (tenantId: string): string => tenantId;

/** The bucket key of a tenant's picture, as the media routes lay it out. */
export const avatarObjectKey = (tenantId: string, key: string): string =>
  mediaPlace(AVATAR_KIND, tenantFolder(tenantId))(key);

/** What a listing of a tenant's objects starts with: the folder and its slash, so no other tenant's id matches. */
export const tenantListPrefix = (tenantId: string): string =>
  `${tenantFolder(tenantId)}/`;
