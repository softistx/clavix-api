import type {
  OAuthClientGrantType,
  OAuthClientRecord,
  OAuthPage,
  OAuthPageOptions,
} from "@softistx/janus-oauth";
import { DEFAULT_GRANTS } from "@/clients/register-client";

/** A client as the console shows it: a janus record without its secret hash. */
export interface ClientView {
  clientId: string;
  name: string;
  type: "public" | "confidential";
  redirectUris: readonly string[];
  /** As recorded on the client (`authorization_code` and `refresh_token` when nothing is), enforced by janus. */
  grantTypes: readonly OAuthClientGrantType[];
  createdAt: Date;
  /** Whether the client must push its authorization requests to `/par` (RFC 9126). */
  requirePushedAuthorizationRequests: boolean;
}

// A listing reads the store page by page and keeps what matches; it stops
// after this many reads and answers a short page with its cursor.
export const MAX_READS = 20;

/** A capability the janus port leaves optional; the Mongo store has them all. */
export function capability<T>(method: T | undefined, name: string): T {
  if (method === undefined) {
    throw new Error(`the OAuth store has no ${name}()`);
  }
  return method;
}

export const viewOf = (record: OAuthClientRecord): ClientView => ({
  clientId: record.id,
  name: record.name,
  type: record.secretHash === undefined ? "public" : "confidential",
  redirectUris: record.redirectUris,
  grantTypes: record.grantTypes ?? DEFAULT_GRANTS,
  createdAt: record.createdAt,
  requirePushedAuthorizationRequests:
    record.requirePushedAuthorizationRequests === true,
});

/** What a listing keeps: a registered client matching `q` (part of its name or id, any case). */
const matcher = (q: string | undefined) => {
  const needle = q?.trim().toLowerCase() ?? "";
  return (record: OAuthClientRecord) =>
    record.source === "registered" &&
    (needle === "" ||
      record.name.toLowerCase().includes(needle) ||
      record.id.includes(needle));
};

// The page size a count reads the store with.
const COUNT_READ = 100;

/**
 * How many registered clients the store holds that match `q`, in all: the
 * cursor plays no part. The store has no count, so it reads every page with
 * the listing's own filter (a tenant holds a few clients, bounded by its quota).
 */
export async function countClientViews(
  listClients: (
    options?: OAuthPageOptions,
  ) => Promise<OAuthPage<OAuthClientRecord>>,
  options: { q?: string | undefined } = {},
): Promise<number> {
  const keep = matcher(options.q);
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await listClients({ cursor, limit: COUNT_READ });
    total += page.items.filter(keep).length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return total;
}

/**
 * One page of the registered clients a store lists, as views, in id order.
 * The store has no search: `q` (part of the name or the id, whatever the
 * case) is applied here. Each read asks for what the page still lacks, so a
 * page never ends inside a read and the store's own cursor stays the page's.
 */
export async function listClientViews(
  listClients: (
    options?: OAuthPageOptions,
  ) => Promise<OAuthPage<OAuthClientRecord>>,
  options: { after?: string | null; limit: number; q?: string | undefined },
): Promise<{ items: ClientView[]; nextCursor: string | null }> {
  const keep = matcher(options.q);
  const items: ClientView[] = [];
  let cursor = options.after ?? undefined;
  for (let reads = 0; reads < MAX_READS; reads += 1) {
    const page = await listClients({
      cursor,
      limit: options.limit - items.length,
    });
    items.push(...page.items.filter(keep).map(viewOf));
    if (page.nextCursor === null) return { items, nextCursor: null };
    cursor = page.nextCursor;
    if (items.length >= options.limit) break;
  }
  return { items, nextCursor: cursor ?? null };
}
