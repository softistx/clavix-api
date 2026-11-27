import { MediaRefusal } from "@softistx/alxia-media";
import { JanusError } from "@softistx/janus";
import type { Context } from "@/http/context";
import { currentOf } from "@/modules/passkeys";
import { fail } from "@/shared/errors";
import { requireLive } from "@/tenancy/live";
import { PICTURE_LOCKED_MESSAGE } from "../media.errors";
import type { AvatarsPorts, AvatarTarget } from "../media.types";
import { removePicture } from "../media.utils";

/**
 * A user's picture in janus. The bytes are written first (the media routes), then
 * `set` records the object's key, so a failure here removes the new object and
 * nothing points at a missing one. The object a change replaces is removed by
 * the `user.avatarChanged` listener, never here.
 */
export class AvatarsService {
  constructor(private readonly ports: AvatarsPorts) {}

  /** Points the user at the object `key`; a user gone is `not_found`, a concurrent write `conflict` (409). */
  async set(target: AvatarTarget, key: string): Promise<void> {
    try {
      await target.auth.avatar.set(target.userId, { id: key });
    } catch (error) {
      if (!(error instanceof JanusError)) throw error;
      if (error.code === "NOT_FOUND") throw new MediaRefusal("not_found");
      if (error.code === "VERSION_CONFLICT") {
        throw new MediaRefusal("conflict", { status: 409 });
      }
      throw error;
    }
  }

  /**
   * Removes the user's picture: `true` when there was one, `false` when there
   * was none. With `setUntil`, a picture set after it is kept (`false`), and
   * the removal is conditional on the user not having changed since the read.
   */
  async remove(target: AvatarTarget, setUntil?: Date): Promise<boolean> {
    return removePicture(target, setUntil);
  }

  /** `removeMyPicture`: the signed-in user's own picture, on the tenant host's session. */
  async removeOwn(ctx: Context): Promise<boolean> {
    const [tenant, auth] = await Promise.all([
      ctx.tenant(),
      this.ports.issuers.forRequest(ctx.request),
    ]);
    if (tenant === null || auth === null) {
      throw fail("NOT_FOUND", "No such tenant", { status: 404 });
    }
    requireLive(tenant);
    const { user } = await currentOf(auth, ctx.request);
    if (await this.ports.pictureLocked(tenant.tenantId)) {
      throw fail("PROFILE_FIELD_LOCKED", PICTURE_LOCKED_MESSAGE, {
        status: 403,
        field: "PICTURE",
      });
    }
    return this.remove({ tenantId: tenant.tenantId, userId: user.id, auth });
  }
}
