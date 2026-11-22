import type { Scoped } from "@softistx/mongo";
import { ConnectionError } from "./connections.errors";
import type { ConnectionDoc, connections } from "./connections.model";
import { MAX_DOMAINS } from "./connections.rules";
import type { LinkCounter } from "./connections.types";

/** One tenant's connections, as every service reads and writes them. */
export type ConnectionsScope = Scoped<typeof connections>;

/** A domain of `domains` that another enabled connection of the tenant already holds. */
export async function assertDomainsFree(
  scoped: ConnectionsScope,
  except: ConnectionDoc,
  domains: readonly string[],
): Promise<void> {
  if (domains.length === 0) return;
  const others = await scoped.findMany({
    filter: { enabled: true, "domains.domain": { $in: [...domains] } },
  });
  if (others.some((other) => !other._id.equals(except._id))) {
    throw new ConnectionError(
      "DOMAIN_TAKEN",
      "A domain of this connection is already held by another enabled connection",
      "domains",
    );
  }
}

/** Refuses while accounts are linked through the connection. */
export async function assertUnlinked(
  links: LinkCounter,
  tenantId: string,
  connectionId: string,
  message: string,
  field?: string,
): Promise<void> {
  if ((await links(tenantId, connectionId)) > 0) {
    throw new ConnectionError("CONNECTION_IN_USE", message, field);
  }
}

/** A domain to claim: not on the connection yet, within the cap, held by no other connection of the tenant. */
export async function assertClaimable(
  scoped: ConnectionsScope,
  current: ConnectionDoc,
  domain: string,
): Promise<void> {
  if (current.domains.some((entry) => entry.domain === domain)) {
    throw new ConnectionError(
      "CONFLICT",
      "This domain is already on the connection",
      "domain",
    );
  }
  if (current.domains.length >= MAX_DOMAINS) {
    throw new ConnectionError(
      "BAD_USER_INPUT",
      `A connection holds at most ${MAX_DOMAINS} domains`,
      "domain",
    );
  }
  const held = await scoped.findMany({ filter: { "domains.domain": domain } });
  if (held.length > 0) {
    throw new ConnectionError(
      "DOMAIN_TAKEN",
      "This domain is already on a connection of this tenant",
      "domain",
    );
  }
}
