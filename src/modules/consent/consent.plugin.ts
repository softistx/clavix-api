import { definePlugin } from "@softistx/graxia";
import type { AgentsFor } from "./consent.agent-marker";
import type { DetailTextsFor } from "./consent.detail-labels";
import type { ScopeTextsFor } from "./consent.scope-labels";
import type { ServerSource, WithServers } from "./consent.types";

/**
 * Puts the app's OAuth servers on the GraphQL context (`createApp({ oauth })`),
 * and the readers of the tenants' scope texts, which the consent page shows
 * instead of the bare scope names, and of their detail type texts, which it
 * shows as the request's `details`, and of the tenant's agents, which marks
 * a client as an agent.
 */
export const oauthContext = (
  oauth: ServerSource,
  texts?: ScopeTextsFor,
  detailTexts?: DetailTextsFor,
  agents?: AgentsFor,
) =>
  definePlugin({
    name: "clavix-oauth-context",
    onContext: (): WithServers => ({
      oauthServers: oauth,
      ...(texts === undefined ? {} : { scopeTextsFor: texts }),
      ...(detailTexts === undefined ? {} : { detailTextsFor: detailTexts }),
      ...(agents === undefined ? {} : { agentsFor: agents }),
    }),
  });
