import { MediaRefusal, mediaRoutes } from "@softistx/alxia-media";
import {
  AVATAR_KIND,
  type AvatarAccessPorts,
  AvatarAccessService,
  type AvatarRequires,
  type AvatarsService,
  type AvatarThrottle,
  answerOf,
  avatarKind,
  MEDIA_PREFIX,
  type MediaStore,
  tenantFolder,
} from "@/modules/media";
import type { Base } from "./context";

/** What the `/media` mount reads of the app's options. */
export interface MediaPorts {
  /** The private bucket of the pictures (`noMediaStore` without one: 503). */
  store: MediaStore;
  /** Records the uploaded object as the user's picture. */
  avatars: Pick<AvatarsService, "set">;
  /** The janus instance of the request's host (a user's own picture). */
  issuers: AvatarAccessPorts["issuers"];
  /** The janus instance of a tenant by id (a console caller's write). */
  janusOf: AvatarAccessPorts["janusOf"];
  /** Whether the tenant locks the `PICTURE` field (a user's own upload is then refused). */
  pictureLocked: AvatarAccessPorts["pictureLocked"];
  /** The upload budget, per user, client address and tenant. */
  throttle: AvatarThrottle;
}

/**
 * Mounts `PUT /media/avatar` and `GET /media/avatar/<key>` beside `/graphql`.
 * Mounted before the body limit: a picture is up to 1 MiB, and the routes
 * enforce their own size. Objects live under the tenant's folder of the
 * bucket (`<tenantId>/avatar/<key>`): a write goes to the target's tenant, a
 * read to the host's, so a key of another tenant is a 404. The picture is
 * recorded in janus once its bytes are stored; if that fails, the object is
 * removed. Refusals are the API's own `{ errors }` body, never cached.
 */
export function mountMedia(
  app: Base,
  ports: MediaPorts,
  admin: AvatarAccessPorts["admin"],
) {
  const { avatars, store, throttle } = ports;
  const access = new AvatarAccessService({
    issuers: ports.issuers,
    janusOf: ports.janusOf,
    pictureLocked: ports.pictureLocked,
    admin,
  });
  return app.decorate({ avatarThrottle: throttle }).plugin(
    mediaRoutes<AvatarRequires>([avatarKind(access)], {
      bucket: store,
      prefix: MEDIA_PREFIX,
      refusal: (refusal, ctx) => {
        const { status, body, headers } = answerOf(refusal);
        return ctx.reply(status, body, { headers });
      },
      keyPrefix: async (ctx, kind) => {
        if (kind !== AVATAR_KIND) return undefined;
        if (ctx.request.method === "PUT") {
          return tenantFolder((await access.targetOf(ctx)).tenantId);
        }
        const tenant = await ctx.tenant();
        if (tenant === null) throw new MediaRefusal("not_found");
        return tenantFolder(tenant.tenantId);
      },
      uploaded: async (uploaded, ctx) => {
        await avatars.set(await access.targetOf(ctx), uploaded.key);
        return {
          key: uploaded.key,
          contentType: uploaded.contentType,
          size: uploaded.size,
        };
      },
    }),
  );
}
