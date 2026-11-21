import { fail } from "@/shared/errors";
import { localeOf } from "./consent.scope-labels";
import type { ConsentCtx } from "./consent.types";

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

/** The request a context carries; `NOT_FOUND` when it carries none. */
export const requestOf = (ctx: unknown): Request => {
  const { request } = ctx as { request?: Request };
  if (request === undefined)
    throw fail("NOT_FOUND", "Not found", { status: 404 });
  return request;
};

/** The locale a context's request asks for (`accept-language`). */
export const localeOfCtx = (ctx: ConsentCtx) =>
  localeOf(ctx.request?.headers.get("accept-language") ?? null);
