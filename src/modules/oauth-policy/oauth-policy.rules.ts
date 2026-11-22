import { redirectUriProblem } from "@softistx/janus-oauth";
import { parse } from "tldts";
import { unique } from "@/shared/values";
import { AgentsInputError } from "./oauth-policy.errors";
import type { AgentsPolicy } from "./oauth-policy.schema";
import type { AgentsPolicyInput } from "./oauth-policy.types";

/** What a list may hold, and a redirect URI's length. */
export const MAX_AGENT_LIST = 50;
export const MAX_REDIRECT_URI = 2000;

// A DNS name, or `*.` and a DNS name (janus's wildcard host): labels of a-z, 0-9 and "-", at least two (a bare name is no host a
// document is served from), at most 253 characters. No scheme, port or path.
const HOST =
  /^(?=.{1,253}$)(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Whether `host` is `*.` over a public suffix (`*.co.uk`, `*.github.io`): such
 * a wildcard would let anyone who registers under the suffix serve a client
 * document. The list is the Public Suffix List (ICANN and private sections),
 * through tldts; a name with no registrable domain is a suffix itself.
 */
export const wildcardOverSuffix = (host: string) =>
  host.startsWith("*.") &&
  parse(host.slice(2), { allowPrivateDomains: true }).domain === null;

/**
 * The agents policy after `input`: the lists are checked and cleaned (a
 * redirect URI janus refuses, a host that is not a DNS name or a list past 50
 * is an `AgentsInputError`, never a silent drop), repeats removed, hosts
 * lower-cased.
 */
export function applyAgentsInput(
  current: AgentsPolicy,
  input: AgentsPolicyInput | null | undefined,
): AgentsPolicy {
  if (input === null || input === undefined) return current;
  const redirectUris =
    input.redirectUris === undefined
      ? current.redirectUris
      : unique(input.redirectUris.map((uri) => uri.trim()));
  const allowHosts =
    input.allowHosts === undefined
      ? current.allowHosts
      : unique(input.allowHosts.map((host) => host.trim().toLowerCase()));
  if (
    redirectUris.length > MAX_AGENT_LIST ||
    allowHosts.length > MAX_AGENT_LIST
  ) {
    throw new AgentsInputError(
      `A list holds ${MAX_AGENT_LIST} entries at most`,
    );
  }
  if (input.redirectUris !== undefined) {
    for (const uri of redirectUris) {
      const problem =
        uri.length > MAX_REDIRECT_URI
          ? `longer than ${MAX_REDIRECT_URI} characters`
          : redirectUriProblem(uri);
      if (problem !== null) {
        throw new AgentsInputError(
          `redirect URI "${uri.slice(0, 80)}": ${problem}`,
        );
      }
    }
  }
  if (input.allowHosts !== undefined) {
    for (const host of allowHosts) {
      if (!HOST.test(host)) {
        throw new AgentsInputError(
          `host "${host.slice(0, 80)}" must be a DNS name, with no scheme, port or path`,
        );
      }
      if (wildcardOverSuffix(host)) {
        throw new AgentsInputError(
          `host "${host.slice(0, 80)}" is a wildcard over a public suffix; name a registrable domain (e.g. *.example.com)`,
        );
      }
    }
  }
  return {
    dynamic: input.dynamic ?? current.dynamic,
    redirectUris,
    metadataDocuments: input.metadataDocuments ?? current.metadataDocuments,
    allowHosts,
  };
}

/** Whether two agents policies are the same. */
export const sameAgents = (a: AgentsPolicy, b: AgentsPolicy) =>
  a.dynamic === b.dynamic &&
  a.metadataDocuments === b.metadataDocuments &&
  a.redirectUris.length === b.redirectUris.length &&
  a.redirectUris.every((uri, i) => uri === b.redirectUris[i]) &&
  a.allowHosts.length === b.allowHosts.length &&
  a.allowHosts.every((host, i) => host === b.allowHosts[i]);

/**
 * D14: agents are on while the whole tenant must push (PAR) or prove (DPoP). A
 * tenant-wide switch has no exemption, so an MCP client that does neither is
 * refused: the console warns.
 */
export const agentsNeedPushOrProof = (policy: {
  par: { required: boolean };
  dpop: { required: boolean };
  agents: AgentsPolicy;
}) =>
  (policy.agents.dynamic !== "off" || policy.agents.metadataDocuments) &&
  (policy.par.required || policy.dpop.required);
