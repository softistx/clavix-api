import type { TokenExchangeRules } from "@/modules/client-policies/client-policies.model";
import type { ClientPoliciesService } from "@/modules/client-policies/client-policies.service";
import { validateTokenExchange } from "@/modules/client-policies/validate";
import { CatalogError } from "@/modules/resources";
import type { CliTenant } from "@/shared/cli";
import type { ClientView } from "./client-listing";

/** The client's token exchange rules (RFC 8693); `null` when it has none. */
export async function clientTokenExchange(
  policies: ClientPoliciesService,
  tenant: CliTenant,
  clientId: string,
) {
  return (await policies.tokenExchange(tenant._id, clientId)) ?? null;
}

/** The token exchange rules of these clients, by client id (one read). */
export async function tokenExchangesOf(
  policies: ClientPoliciesService,
  tenant: CliTenant,
  clientIds: readonly string[],
) {
  return (
    (await policies.tokenExchangeOf(tenant._id, clientIds)) ??
    new Map<string, TokenExchangeRules>()
  );
}

/**
 * Replaces the client's token exchange rules. The client is a confidential
 * one of the tenant, each target one of the tenant's resources
 * (`resourceUris`), and the subject clients are `"any"` or a list of
 * client ids (checked for shape only: a client may be created later), and
 * `subjectAgents` also covers the tokens of the tenant's agents (D12).
 * Delegation is the only mode.
 */
export async function setClientTokenExchange(
  policies: ClientPoliciesService,
  tenant: CliTenant,
  client: ClientView,
  input: {
    targetResources: readonly string[];
    subjectClients: readonly string[] | "any";
    subjectAgents?: boolean;
  },
  resourceUris: readonly string[],
): Promise<TokenExchangeRules> {
  if (client.type !== "confidential") {
    throw new CatalogError(
      "BAD_USER_INPUT",
      "Only a confidential client can exchange tokens",
    );
  }
  const { targets, subjects, agents } = validateTokenExchange(
    input,
    resourceUris,
  );
  return policies.setTokenExchange(tenant._id, client.clientId, {
    targetResources: targets,
    subjectClients: subjects,
    subjectAgents: agents,
    mode: "delegation",
  });
}
