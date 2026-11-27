import { MediaRefusal } from "@softistx/alxia-media";
import { type BoundBucket, bindBucket, defineBucket } from "@softistx/s3";

/**
 * What the media module asks of the private bucket: the routes' `open`, `put`
 * and `delete`, and `list` for the tenant purge. Nothing is signed for a
 * browser: pictures are served by `/media`.
 */
export type MediaStore = Pick<
  BoundBucket<{ readonly key: string }>,
  "open" | "put" | "delete" | "list"
>;

/** Where the bucket is and how to sign in to it (`CLAVIX_MEDIA_S3_*`). */
export interface MediaStoreConfig {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/** The S3 bucket of the pictures: an object's key is the key it is given. */
export const s3MediaStore = (config: MediaStoreConfig): MediaStore =>
  bindBucket(
    defineBucket({
      bucket: config.bucket,
      key: (params: { readonly key: string }) => params.key,
    }),
    {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      virtualHostedStyle: false,
      endpoint: config.endpoint,
    },
  );

/**
 * No storage (`CLAVIX_MEDIA_S3_*` unset outside production): a read or a write
 * answers 503, and there is nothing to remove or list, so erasing a user or
 * purging a tenant still goes through.
 */
export const noMediaStore: MediaStore = {
  open: async () => {
    throw new MediaRefusal("unavailable");
  },
  put: async () => {
    throw new MediaRefusal("unavailable");
  },
  delete: async () => {},
  list: async () => ({ items: [], nextCursor: null }),
};
