import type { OAuthTokenExchangeOptions } from "@softistx/janus-oauth";
import type { ExchangeRules } from "./ports";

/**
 * RFC 8693: the token exchange policy of a tenant, gated per client by its
 * grants (the exchange URN is never implied) and by its rules in
 * `clientPolicies`. Default-deny, delegation only: a client with no rules, a
 * subject token of a client it does not list or a target it does not list is
 * `access_denied` (`null`). With `subjectAgents` (D12) the tokens of any agent
 * of the tenant (a client in `agentClients`) are covered too; a client that is
 * no agent never is. The exchanged token keeps the subject's authorization
 * details on the same resource (janus's default); janus only lets the scopes
 * and details narrow.
 */
export const exchangePolicy =
  (
    rulesOf: ((clientId: string) => Promise<ExchangeRules | null>) | undefined,
    isAgent?: (clientId: string) => Promise<boolean>,
  ): OAuthTokenExchangeOptions["policy"] =>
  async ({ clientId, subject, resource }) => {
    const rules = await rulesOf?.(clientId);
    if (rules === undefined || rules === null) return null;
    if (!rules.targetResources.includes(resource)) return null;
    if (
      rules.subjectClients !== "any" &&
      !rules.subjectClients.includes(subject.clientId) &&
      !(rules.subjectAgents && (await isAgent?.(subject.clientId)) === true)
    ) {
      return null;
    }
    return { mode: "delegation" };
  };
