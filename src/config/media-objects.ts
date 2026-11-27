import {
  AvatarObjectsService,
  noMediaStore,
  s3MediaStore,
} from "@/modules/media";
import { env } from "./env";
import { warn } from "./runtime";

const {
  CLAVIX_MEDIA_S3_ENDPOINT: endpoint,
  CLAVIX_MEDIA_S3_BUCKET: bucket,
  CLAVIX_MEDIA_S3_ACCESS_KEY_ID: accessKeyId,
  CLAVIX_MEDIA_S3_SECRET_ACCESS_KEY: secretAccessKey,
  CLAVIX_MEDIA_S3_REGION: region,
} = env;

/**
 * The private bucket of the pictures, or none (`noMediaStore`) where
 * `CLAVIX_MEDIA_S3_*` is unset, which production refuses to start without.
 * Kept apart from `media.ts`, which needs the users: the users' events remove
 * the replaced objects through it.
 */
export const mediaStore =
  endpoint === undefined ||
  bucket === undefined ||
  accessKeyId === undefined ||
  secretAccessKey === undefined
    ? noMediaStore
    : s3MediaStore({ endpoint, bucket, accessKeyId, secretAccessKey, region });

/** The picture objects: removed on an erase, a replacement and a tenant purge. */
export const avatarObjects = new AvatarObjectsService(mediaStore, warn);
