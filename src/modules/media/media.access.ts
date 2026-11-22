import { MediaRefusal } from "@softistx/alxia-media";
import { ObjectId } from "mongodb";

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
