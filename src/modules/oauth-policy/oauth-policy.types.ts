import type { AGENT_MODES } from "./oauth-policy.schema";

/** The change an admin makes to the agents policy: a field left out keeps its value. */
export interface AgentsPolicyInput {
  dynamic?: (typeof AGENT_MODES)[number] | undefined;
  redirectUris?: readonly string[] | undefined;
  metadataDocuments?: boolean | undefined;
  allowHosts?: readonly string[] | undefined;
}

/** The change an admin makes to the policy: a flag left out keeps its value. */
export interface OAuthPolicyInput {
  par?: { required?: boolean | undefined } | undefined;
  dpop?: { required?: boolean | undefined } | undefined;
  agents?: AgentsPolicyInput | null | undefined;
}
