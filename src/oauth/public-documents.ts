import type { KeyGenerations } from "@/keys/generations";
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
  /** Entries kept at most; the oldest goes first. Default 5000. */
  maxEntries?: number;
  now?: () => number;
}

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
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const answer = (entry: Entry, request: Request): Response => {
    const headers = new Headers(entry.headers);
    headers.set("etag", entry.etag);
    const condition = request.headers.get("if-none-match");
    if (condition !== null && matches(condition, entry.etag))
      return new Response(null, { status: 304, headers });
    return new Response(entry.body, { status: entry.status, headers });
  };

  return {
    ...oauth,
    handle: async (request: Request, ip?: string | undefined) => {
      const { pathname, host } = new URL(request.url);
      if (request.method !== "GET" || !DOCUMENTS.has(pathname))
        return oauth.handle(request, ip);
      const tenant = await resolver.resolveRequest(request);
      if (tenant === null) return oauth.handle(request, ip);
      const key = `${tenant.tenantId}.${tenant.version}.${generations.of(tenant.tenantId)}`;
      const slot = `${host.toLowerCase()}${pathname}`;
      const hit = entries.get(slot);
      if (hit !== undefined && hit.key === key && hit.expiresAt > now())
        return answer(hit, request);
      const response = await oauth.handle(request, ip);
      if (response.status !== 200) return response;
      const body = await response.text();
      const entry: Entry = {
        key,
        expiresAt: now() + ttl,
        body,
        headers: [...response.headers].filter(([name]) => name !== "etag"),
        etag: `"${Bun.hash(body).toString(36)}"`,
        status: 200,
      };
      entries.delete(slot);
      entries.set(slot, entry);
      if (entries.size > max) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      return answer(entry, request);
    },
  };
}
