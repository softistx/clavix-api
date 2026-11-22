import type { MediaRefusal } from "@softistx/alxia-media";
import type { ErrorCode } from "@/i18n/codes";
import { defineCodes } from "@/i18n/define-codes";

// The codes this module raises (the inventory: src/i18n/codes.ts).
export const codes = defineCodes("media", [
  "MEDIA_UNSUPPORTED_TYPE",
  "MEDIA_TOO_LARGE",
]);

/** The refusal of a locked PICTURE, worded once for `/media` and `removeMyPicture`. */
export const PICTURE_LOCKED_MESSAGE =
  "PICTURE is locked by the tenant: only an administrator changes it";

/** The statuses a media refusal is answered with. */
export type AnswerStatus =
  | 400
  | 401
  | 403
  | 404
  | 408
  | 409
  | 413
  | 415
  | 416
  | 422
  | 429
  | 503;

interface Refusal {
  readonly code: ErrorCode;
  readonly status: AnswerStatus;
  readonly message: string;
  /** The profile field a refusal names, in the error's extensions. */
  readonly field?: string;
}

// Each way the routes turn a request away, as the API's own code (the media
// package's `{ error }` answer is never sent). A code the table lacks is a
// malformed request.
const REFUSALS: ReadonlyMap<string, Refusal> = new Map([
  [
    "unauthenticated",
    { code: "UNAUTHENTICATED", status: 401, message: "Not signed in" },
  ],
  ["forbidden", { code: "FORBIDDEN", status: 403, message: "Not allowed" }],
  [
    "locked",
    {
      code: "PROFILE_FIELD_LOCKED",
      status: 403,
      message: PICTURE_LOCKED_MESSAGE,
      field: "PICTURE",
    },
  ],
  ["not_found", { code: "NOT_FOUND", status: 404, message: "No such file" }],
  [
    "conflict",
    { code: "CONFLICT", status: 409, message: "Changed meanwhile, retry" },
  ],
  [
    "unsupported_type",
    {
      code: "MEDIA_UNSUPPORTED_TYPE",
      status: 415,
      message: "Use a PNG, JPEG or WebP picture",
    },
  ],
  [
    "too_large",
    {
      code: "MEDIA_TOO_LARGE",
      status: 413,
      message: "The picture is over 1 MiB",
    },
  ],
  [
    "throttled",
    { code: "RATE_LIMITED", status: 429, message: "Too many pictures sent" },
  ],
  [
    "unavailable",
    {
      code: "SERVICE_UNAVAILABLE",
      status: 503,
      message: "Pictures are unavailable, try again later",
    },
  ],
  [
    "stalled",
    { code: "BAD_USER_INPUT", status: 408, message: "The upload stalled" },
  ],
  [
    "range_not_satisfiable",
    { code: "BAD_USER_INPUT", status: 416, message: "Range not satisfiable" },
  ],
  [
    "unprocessable",
    { code: "BAD_USER_INPUT", status: 422, message: "Unreadable picture" },
  ],
]);

const MALFORMED: Refusal = {
  code: "BAD_USER_INPUT",
  status: 400,
  message: "The picture could not be read",
};

/** What a media refusal is answered with: the API's own `{ errors }` body, never cached, `Retry-After` for a throttle. */
export function answerOf(refusal: MediaRefusal) {
  const { code, status, message, field } =
    REFUSALS.get(refusal.code) ?? MALFORMED;
  const retryAfter = refusal.details.retryAfter;
  return {
    status,
    body: {
      errors: [
        {
          message,
          extensions: field === undefined ? { code } : { code, field },
        },
      ],
    },
    headers: {
      "cache-control": "no-store",
      ...(retryAfter === undefined
        ? {}
        : { "retry-after": String(retryAfter) }),
    },
  };
}
