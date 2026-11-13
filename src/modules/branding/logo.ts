import { createHash } from "node:crypto";
import { BrandingInputError } from "./theme";

/** The largest logo stored (bytes). */
export const LOGO_MAX_BYTES = 256 * 1024;

// Raster formats only: an SVG can carry script and is served from the tenant's own host.
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  "image/png": (b) =>
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (x, i) => b[i] === x,
    ),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) =>
    String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.slice(8, 12)) === "WEBP",
};

export interface StoredLogo {
  contentType: string;
  /** base64 */
  data: string;
  /** sha256 hex of the bytes: the ETag. */
  hash: string;
  size: number;
}

/** Decodes and checks an uploaded logo (type allow-list, magic bytes, size); throws `BrandingInputError`. */
export function checkLogo(input: {
  contentType: string;
  dataBase64: string;
}): StoredLogo {
  const contentType = input.contentType.trim().toLowerCase();
  const signature = SIGNATURES[contentType];
  if (signature === undefined) {
    throw new BrandingInputError("logo", "a PNG, JPEG or WebP image");
  }
  const clean = input.dataBase64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw new BrandingInputError("logo", "not valid base64");
  }
  if (clean.length > Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 4) {
    throw new BrandingInputError("logo", "larger than 256 KiB");
  }
  const bytes = Buffer.from(clean, "base64");
  if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) {
    throw new BrandingInputError("logo", "empty or larger than 256 KiB");
  }
  if (!signature(bytes)) {
    throw new BrandingInputError("logo", "the bytes are not that image type");
  }
  return {
    contentType,
    data: bytes.toString("base64"),
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}
