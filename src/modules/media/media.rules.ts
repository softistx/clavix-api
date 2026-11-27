// The profile picture's kind of file: what `/media/avatar` takes and where it
// lives. A picture is a raster image of a few hundred kilobytes at most.

/** The kind's name: the URL segment and the bucket's folder under the tenant's. */
export const AVATAR_KIND = "avatar";

/** Where the media routes are mounted on a tenant host. */
export const MEDIA_PREFIX = "/media";

/** The types a picture may have: raster only, never SVG (it can carry script). */
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** The most bytes a picture may have. */
export const AVATAR_MAX_BYTES = 1024 * 1024;

/** Served for a year and never revalidated: a new picture has a new key. */
export const AVATAR_CACHE_CONTROL = "public, max-age=31536000, immutable";
