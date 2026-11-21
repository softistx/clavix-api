import type { KeyGenerations } from "@/modules/keys";
import type { TenantResolver } from "@/tenancy/resolver";

/** The documents a relying party fetches all the time and that change rarely. */
const DOCUMENTS = new Set([
  "/jwks.json",
  "/.well-known/openid-configuration",
  "/.well-known/oauth-authorization-server",
]);

interface Entry {
  /** `${tenantId}.${tenant version}.${keys generation}`: a change of any of them misses. */
  key: string;
  expiresAt: number;
  body: string;
  headers: [string, string][];
  etag: string;
  status: number;
}

export interface PublicDocumentsOptions {
  resolver: Pick<TenantResolver, "resolveRequest">;
  generations: KeyGenerations;
  /** Seconds an entry is served at most: the bound for what the key cannot see (another instance's rotation, a retired key's `publishUntil`, a resource or scope change in discovery). Default 60. */
  ttlSeconds?: number;
  /** Entries kept at most; the oldest inserted goes first. Default 5000. */
  maxEntries?: number;
  now: () => number;
}

/** A cacheable document request: a GET of one of the documents; its path and host slot. */
const documentSlotOf = (request: Request): string | null => {
  const { pathname, host } = new URL(request.url);
  if (request.method !== "GET" || !DOCUMENTS.has(pathname)) return null;
  return `${host.toLowerCase()}${pathname}`;
};

/** A 200 response's body as an entry, without the headers the entry sets itself. */
const entryOf = (
  response: Response,
  body: string,
  key: string,
  expiresAt: number,
): Entry => ({
  key,
  expiresAt,
  body,
  headers: [...response.headers].filter(
    ([name]) => name !== "etag" && name !== "content-length",
  ),
  etag: `"${Bun.hash(body).toString(36)}"`,
  status: 200,
});

const matches = (header: string, etag: string) =>
  header.trim() === "*" ||
  header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .includes(etag);

/**
 * Wraps the issuers' `handle`: the JWKS and the two discovery documents of a
 * tenant are served from memory (the serialized body and its ETag) while the
 * tenant, its `version` and its keys' generation are unchanged and the entry
 * is younger than the TTL, with no store read, and answer 304 to a matching
 * `If-None-Match`. Everything else, and a host with no tenant, goes through.
 * A document is cached only when janus answered 200.
 */
export function withPublicDocuments<
  T extends {
    handle: (request: Request, ip?: string | undefined) => Promise<Response>;
  },
>(oauth: T, options: PublicDocumentsOptions): T {
  const { resolver, generations } = options;
  const ttl = (options.ttlSeconds ?? 60) * 1000;
  const max = options.maxEntries ?? 5000;
  const now = options.now;
  const entries = new Map<string, Entry>();
  // One janus call per slot and key at a time: a cold or expired entry is not
  // refilled by every concurrent request (7 store reads each).
  const filling = new Map<string, Promise<Entry | Response>>();

  const answer = (entry: Entry, request: Request): Response => {
    const headers = new Headers(entry.headers);
    headers.set("etag", entry.etag);
    const condition = request.headers.get("if-none-match");
    if (condition !== null && matches(condition, entry.etag))
      return new Response(null, { status: 304, headers });
    return new Response(entry.body, { status: entry.status, headers });
  };

  const fill = async (
    request: Request,
    ip: string | undefined,
    slot: string,
    key: string,
  ): Promise<Entry | Response> => {
    const response = await oauth.handle(request, ip);
    if (response.status !== 200) return response;
    const body = await response.text();
    const entry = entryOf(response, body, key, now() + ttl);
    entries.delete(slot);
    entries.set(slot, entry);
    if (entries.size > max) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    return entry;
  };

  return {
    ...oauth,
    handle: async (request: Request, ip?: string | undefined) => {
      const slot = documentSlotOf(request);
      if (slot === null) return oauth.handle(request, ip);
      const tenant = await resolver.resolveRequest(request);
      if (tenant === null) return oauth.handle(request, ip);
      const key = `${tenant.tenantId}.${tenant.version}.${generations.of(tenant.tenantId)}.${tenant.issuer}`;
      const hit = entries.get(slot);
      if (hit !== undefined && hit.key === key && hit.expiresAt > now())
        return answer(hit, request);
      const flight = `${slot}|${key}`;
      let pending = filling.get(flight);
      if (pending === undefined) {
        pending = fill(request, ip, slot, key).finally(() =>
          filling.delete(flight),
        );
        filling.set(flight, pending);
      }
      const filled = await pending;
      // A refusal or other non-200 is not cached: each caller gets its own copy.
      return filled instanceof Response
        ? filled.clone()
        : answer(filled, request);
    },
  };
}
