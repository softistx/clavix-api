import { MediaRefusal, mediaPlace } from "@softistx/alxia-media";
import { ObjectId } from "mongodb";
import { AVATAR_KIND } from "./media.rules";
import type { AvatarTarget } from "./media.types";

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

/** The query a console caller names the user with: `?tenantId=&userId=`. */
export interface AdminQuery {
  readonly tenantId: string;
  readonly userId: string;
}

/** The user an admin write names, or `null` for a request that names none (the signed-in user's own). */
export function adminQueryOf(url: URL): AdminQuery | null {
  const tenantId = url.searchParams.get("tenantId");
  const userId = url.searchParams.get("userId");
  if (tenantId === null && userId === null) return null;
  if (tenantId === null || userId === null || !ObjectId.isValid(tenantId)) {
    throw new MediaRefusal("not_found");
  }
  return { tenantId, userId };
}

/**
 * Whether a cookie-authenticated write comes from another site: a browser
 * says so in `Sec-Fetch-Site`. A server-side caller sends none.
 */
export function crossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

/**
 * Removes the user's picture in janus: `true` when there was one, `false` when
 * there was none (or the user is gone). With `setUntil`, a picture set after it
 * is kept (`false`), and the removal is conditional on the user not having
 * changed since the read. The `user.avatarRemoved` listener removes the object.
 */
export async function removePicture(
  target: AvatarTarget,
  setUntil?: Date,
): Promise<boolean> {
  const user = await target.auth.findUser(target.userId);
  if (user === null || user.avatar === null) return false;
  if (setUntil !== undefined && user.avatar.updatedAt > setUntil) return false;
  await target.auth.avatar.remove(
    target.userId,
    setUntil === undefined ? undefined : { ifVersion: user.version },
  );
  return true;
}
