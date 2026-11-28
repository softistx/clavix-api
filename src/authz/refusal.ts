import type { MapRefusal } from "@softistx/limix-graxia";

/**
 * A limix refusal worded with Clavix's own codes (`i18n/codes.ts`), so a
 * client sees the same `extensions.code` as before limix guarded the API:
 * `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, and
 * `SERVICE_UNAVAILABLE` 503 for a policy that is not held.
 */
export const mapRefusal: MapRefusal = (refusal) => {
  switch (refusal.code) {
    case "auth.errors.unauthenticated":
      return {
        code: "UNAUTHENTICATED",
        message: "Not signed in",
        status: 401,
      };
    case "auth.errors.forbidden":
      return { code: "FORBIDDEN", message: "Not allowed", status: 403 };
    case "auth.errors.not-found":
      return { code: "NOT_FOUND", message: "Not found", status: 404 };
    case "limix.errors.unavailable":
      return {
        code: "SERVICE_UNAVAILABLE",
        message: "Try again later",
        status: 503,
      };
    default:
      return undefined;
  }
};
