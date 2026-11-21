import type { TenantResolver } from "@/tenancy/resolver";
import type { StoredBrandingDoc } from "./branding.types";

/** Where a tenant's logo is served, on its own host. */
export const LOGO_PATH = "/branding/logo";

const versionOf = (hash: string) => hash.slice(0, 16);

/**
 * The URL the hosted pages put in an `<img>`. `v` is the start of the image's
 * hash, so the URL changes with the image: asked with the current `v`, the
 * logo is served `immutable`.
 */
export const logoUrl = (hash: string) => `${LOGO_PATH}?v=${versionOf(hash)}`;

// Only a URL that names the image it gets may be kept for good.
const IMMUTABLE = "public, max-age=31536000, immutable";
// The bare path (or a stale `v`) is whatever the logo is now: revalidated.
const REVALIDATED = "public, max-age=300, must-revalidate";

/**
 * `GET /branding/logo`: the logo of the tenant the host names, with an ETag
 * (the image's sha256) and a 304 on `If-None-Match`. `immutable` only when
 * `?v=` is the current image's (`logoUrl`), five minutes then revalidated
 * otherwise. 404 for an unknown host or a tenant with no logo. Never sniffed,
 * never scripted.
 */
export function logoRoute(deps: {
  resolver: TenantResolver;
  service: {
    get(tenantId: string): Promise<StoredBrandingDoc | undefined>;
  };
}) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }
    const tenant = await deps.resolver.resolveRequest(request);
    const found =
      tenant === null ? undefined : await deps.service.get(tenant.tenantId);
    const logo = found?.logo;
    if (logo === null || logo === undefined) {
      return new Response("Not found", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
    const etag = `"${logo.hash}"`;
    const headers = {
      etag,
      "cache-control":
        new URL(request.url).searchParams.get("v") === versionOf(logo.hash)
          ? IMMUTABLE
          : REVALIDATED,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    };
    const presented = request.headers.get("if-none-match");
    const matches = presented
      ?.split(",")
      .map((v) => v.trim().replace(/^W\//, ""))
      .some((v) => v === etag || v === "*");
    if (matches === true) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(Buffer.from(logo.data, "base64"), {
      status: 200,
      headers: { ...headers, "content-type": logo.contentType },
    });
  };
}
