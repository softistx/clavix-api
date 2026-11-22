import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { CatalogError } from "@/modules/resources";
import { partitionOf } from "@/modules/tenants";
import type { CliTenant } from "@/shared/cli";
import {
  checkQuery,
  clientIdOf,
  MAX_CURSOR,
  sameClient,
} from "./clients.rules";
import { countClientViews, listClientViews } from "./clients.search";
import type {
  ClientListOptions,
  ClientsServiceOptions,
  ClientView,
  CreateClientInput,
} from "./clients.types";
import { agentKindsOf, capability, viewOf } from "./clients.utils";

/**
 * The agent-aware reads of a tenant's OAuth clients, as functions over the
 * service's ports (`ClientsService` calls them): the janus store is the truth
 * (one partition per tenant) and the agents store tells which clients are
 * agents.
 */
export type ReadsOptions = Pick<ClientsServiceOptions, "db" | "agents">;

/** The tenant's janus store (its own partition). */
export function storeOf(options: ReadsOptions, tenant: CliTenant) {
  return createMongoOAuth(options.db, { partition: partitionOf(tenant._id) });
}

/** The tenant's agents among some client ids. */
export function agentsOf(options: ReadsOptions, tenant: CliTenant) {
  return agentKindsOf(options.agents, tenant);
}

/**
 * A registered client; `null` for an unknown one. A client a metadata
 * document describes is returned only with `agents: true` (the read-only
 * view of the console): the writes never see it.
 */
export async function findClientView(
  options: ReadsOptions,
  tenant: CliTenant,
  clientId: string,
  flags: { agents?: boolean } = {},
): Promise<ClientView | null> {
  const record = await storeOf(options, tenant).findClient(clientId);
  if (record === null) return null;
  if (record.source !== "registered" && flags.agents !== true) return null;
  return viewOf(record, await agentsOf(options, tenant)([clientId]));
}

/** As `findClientView`; an unknown client is a `NOT_FOUND`. */
export async function requireClientView(
  options: ReadsOptions,
  tenant: CliTenant,
  clientId: string,
) {
  const found = await findClientView(options, tenant, clientId);
  if (found === null) throw new CatalogError("NOT_FOUND", "No such client");
  return found;
}

/**
 * Refuses a write on an agent (dynamic or metadata): an agent is read-only in
 * the console, whatever its id looks like. It answers as an unknown client, and
 * runs before any validation that depends on the id.
 */
export async function refuseAgent(
  options: ReadsOptions,
  tenant: CliTenant,
  clientId: string,
) {
  if ((await agentsOf(options, tenant)([clientId])).has(clientId)) {
    throw new CatalogError("NOT_FOUND", "No such client");
  }
}

/**
 * One page of the tenant's clients. `kinds` keeps only those registrations
 * (`console`, `dynamic`, `metadata`); none: every one, the agents included.
 */
export async function listClientPage(
  options: ReadsOptions,
  tenant: CliTenant,
  query: ClientListOptions,
) {
  checkQuery(query.q);
  if ((query.after?.length ?? 0) > MAX_CURSOR) {
    throw new CatalogError("BAD_USER_INPUT", "Unknown cursor");
  }
  return listClientViews(
    capability(storeOf(options, tenant).listClients, "listClients"),
    { ...query, agents: agentsOf(options, tenant) },
  );
}

/** How many clients of the tenant match `q` and `kinds`, whatever the page. */
export async function countClients(
  options: ReadsOptions,
  tenant: CliTenant,
  query: Pick<ClientListOptions, "q" | "kinds"> = {},
) {
  checkQuery(query.q);
  return countClientViews(
    capability(storeOf(options, tenant).listClients, "listClients"),
    { ...query, agents: agentsOf(options, tenant) },
  );
}

/** Whether `input` describes the stored client: a repeat of its creation. */
export async function matchesClient(
  options: ReadsOptions,
  tenant: CliTenant,
  input: CreateClientInput,
): Promise<boolean> {
  const clientId = input.clientId ?? clientIdOf(input.name);
  if (clientId === "") return false;
  const existing = await findClientView(options, tenant, clientId);
  return existing !== null && sameClient(existing, input);
}
