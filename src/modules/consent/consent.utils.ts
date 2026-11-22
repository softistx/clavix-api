import { fail } from "@/shared/errors";
import { isRecord } from "@/shared/values";
import type { ConsentCtx, ServerCtx } from "./consent.types";

/** One read per request, shared by the fields of a page (the texts of a tenant, say). */
export function perRequest<T>() {
  const reads = new WeakMap<Request, Promise<T>>();
  return (request: Request | undefined, read: (r: Request) => Promise<T>) => {
    if (request === undefined) return undefined;
    let found = reads.get(request);
    if (found === undefined) {
      found = read(request);
      reads.set(request, found);
    }
    return found;
  };
}

/**
 * Whether a context is the app's: janus types its context without the tenant,
 * and the app's base puts it there (a function), so `serverOf` can read it.
 */
export const isServerCtx = (ctx: unknown): ctx is ServerCtx =>
  typeof ctx === "object" &&
  ctx !== null &&
  "tenant" in ctx &&
  typeof ctx.tenant === "function";

/** The app's context; a plain `Error` (a masked 500: wired wrong) for one without the tenant reader. */
export const appCtxOf = (ctx: unknown): ServerCtx => {
  if (!isServerCtx(ctx)) {
    throw new Error("The resolver context is not the app's");
  }
  return ctx;
};

/** Whether a context carries the consent readers `oauthContext` puts on it. */
export const isConsentCtx = (ctx: unknown): ctx is ConsentCtx =>
  isRecord(ctx) &&
  isRecord(ctx["oauthServers"]) &&
  typeof ctx["scopeTextsFor"] === "function" &&
  typeof ctx["detailTextsFor"] === "function" &&
  typeof ctx["agentsFor"] === "function";

/** The consent readers' context; a plain `Error` (a masked 500: wired wrong) for any other. */
export const consentCtxOf = (ctx: unknown): ConsentCtx => {
  if (!isConsentCtx(ctx)) {
    throw new Error("The resolver context has no consent readers");
  }
  return ctx;
};

/** The request a context carries; `NOT_FOUND` when it carries none. */
export const requestOf = (ctx: unknown): Request => {
  if (isRecord(ctx) && ctx["request"] instanceof Request) return ctx["request"];
  throw fail("NOT_FOUND", "Not found", { status: 404 });
};

/** The languages a context's request asks for (its `accept-language` header). */
export const acceptLanguageOf = (ctx: ConsentCtx) =>
  ctx.request?.headers.get("accept-language") ?? null;
