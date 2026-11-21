import type {
  OAuthClientRecord,
  OAuthPage,
  OAuthPageOptions,
} from "@softistx/janus-oauth";
import type { AgentKinds, ClientFilter, ClientView } from "./clients.types";
import { registrationOf, viewOf } from "./clients.utils";

// A listing reads the store page by page and keeps what matches; it stops
// after this many reads and answers a short page with its cursor.
export const MAX_READS = 20;

/**
 * What a listing keeps: a client matching `q` (part of its name or id, any
 * case) whose registration is wanted (`filter.kinds`, told apart with the
 * agents `filter.agents` reads).
 */
const matcher = (
  q: string | undefined,
  filter: ClientFilter,
  agents: AgentKinds,
) => {
  const needle = q?.trim().toLowerCase() ?? "";
  const kinds = filter.kinds ?? [];
  return (record: OAuthClientRecord) => {
    if (kinds.length > 0 && !kinds.includes(registrationOf(record, agents))) {
      return false;
    }
    return (
      needle === "" ||
      record.name.toLowerCase().includes(needle) ||
      record.id.includes(needle)
    );
  };
};

/** The agents among one page's records (bounded by the page). */
const agentsAmong = (
  filter: ClientFilter,
  page: OAuthPage<OAuthClientRecord>,
): Promise<AgentKinds> => filter.agents(page.items.map((record) => record.id));

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
  options: { q?: string | undefined } & ClientFilter,
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await listClients({ cursor, limit: COUNT_READ });
    const keep = matcher(options.q, options, await agentsAmong(options, page));
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
  options: {
    after?: string | null;
    limit: number;
    q?: string | undefined;
  } & ClientFilter,
): Promise<{ items: ClientView[]; nextCursor: string | null }> {
  const items: ClientView[] = [];
  let cursor = options.after ?? undefined;
  for (let reads = 0; reads < MAX_READS; reads += 1) {
    const page = await listClients({
      cursor,
      limit: options.limit - items.length,
    });
    const agents = await agentsAmong(options, page);
    items.push(
      ...page.items
        .filter(matcher(options.q, options, agents))
        .map((record) => viewOf(record, agents)),
    );
    if (page.nextCursor === null) return { items, nextCursor: null };
    cursor = page.nextCursor;
    if (items.length >= options.limit) break;
  }
  return { items, nextCursor: cursor ?? null };
}
