import type {
  OAuthClientGrantType,
  OAuthClientRecord,
  OAuthPage,
  OAuthPageOptions,
} from "@softistx/janus-oauth";
import { DEFAULT_GRANTS } from "@/clients/register-client";
import type { AgentKind } from "@/modules/agents/agent-clients.model";

/**
 * How a client came to exist: `console` (registered by an admin or a script),
 * `dynamic` (it registered itself, RFC 7591) or `metadata` (a Client ID
 * Metadata Document describes it). The last two are the tenant's agents.
 */
export type ClientRegistration = "console" | AgentKind;

/** The tenant's recorded agents by client id (`AgentClientsPort.kinds`). */
export type AgentKinds = ReadonlyMap<string, AgentKind>;

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
  /** Whether the client's token requests must carry a DPoP proof (RFC 9449). */
  dpopBoundAccessTokens: boolean;
  /** How the client was registered; an agent is `dynamic` or `metadata`. */
  registration: ClientRegistration;
  /** The authorization detail types (RFC 9396) the client may ask for; empty when it lists none. */
  authorizationDetailsTypes: readonly string[];
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

/** How a janus record was registered: a metadata document is one, a registered client the agents store knows is dynamic. */
export const registrationOf = (
  record: OAuthClientRecord,
  agents: AgentKinds = new Map(),
): ClientRegistration =>
  record.source === "metadata"
    ? "metadata"
    : (agents.get(record.id) ?? "console");

export const viewOf = (
  record: OAuthClientRecord,
  agents?: AgentKinds,
): ClientView => ({
  clientId: record.id,
  name: record.name,
  type: record.secretHash === undefined ? "public" : "confidential",
  redirectUris: record.redirectUris,
  grantTypes: record.grantTypes ?? DEFAULT_GRANTS,
  createdAt: record.createdAt,
  requirePushedAuthorizationRequests:
    record.requirePushedAuthorizationRequests === true,
  dpopBoundAccessTokens: record.dpopBoundAccessTokens === true,
  registration: registrationOf(record, agents),
  authorizationDetailsTypes: record.authorizationDetailsTypes ?? [],
});

/** Which clients a listing keeps, beyond `q`. */
export interface ClientFilter {
  /** The tenant's recorded agents. Without it only the registered clients are listed, all `console`. */
  agents?: AgentKinds | undefined;
  /** Only these registrations; none or an empty list: every one. */
  kinds?: readonly ClientRegistration[] | undefined;
}

/**
 * What a listing keeps: a client matching `q` (part of its name or id, any
 * case) whose registration is wanted. A metadata-document client is listed
 * only when the agents are known (`filter.agents`).
 */
const matcher = (q: string | undefined, filter: ClientFilter = {}) => {
  const needle = q?.trim().toLowerCase() ?? "";
  const kinds = filter.kinds ?? [];
  return (record: OAuthClientRecord) => {
    if (record.source !== "registered" && filter.agents === undefined) {
      return false;
    }
    if (
      kinds.length > 0 &&
      !kinds.includes(registrationOf(record, filter.agents))
    ) {
      return false;
    }
    return (
      needle === "" ||
      record.name.toLowerCase().includes(needle) ||
      record.id.includes(needle)
    );
  };
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
  options: { q?: string | undefined } & ClientFilter = {},
): Promise<number> {
  const keep = matcher(options.q, options);
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
  options: {
    after?: string | null;
    limit: number;
    q?: string | undefined;
  } & ClientFilter,
): Promise<{ items: ClientView[]; nextCursor: string | null }> {
  const keep = matcher(options.q, options);
  const items: ClientView[] = [];
  let cursor = options.after ?? undefined;
  for (let reads = 0; reads < MAX_READS; reads += 1) {
    const page = await listClients({
      cursor,
      limit: options.limit - items.length,
    });
    items.push(
      ...page.items
        .filter(keep)
        .map((record) => viewOf(record, options.agents)),
    );
    if (page.nextCursor === null) return { items, nextCursor: null };
    cursor = page.nextCursor;
    if (items.length >= options.limit) break;
  }
  return { items, nextCursor: cursor ?? null };
}
