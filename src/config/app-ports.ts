import { agentsFor } from "./agent-clients";
import { env } from "./env";
import { detailTextsFor, scopeTextsFor } from "./resources";
import {
  deviceThrottle,
  homeRealmThrottle,
  passkeyThrottle,
  signInThrottle,
  ssoStartThrottle,
  verifyThrottle,
} from "./throttle";

/**
 * The ports `createApp` requires, bound once: the anonymous operations'
 * limits (Redis, the named no-op without it) and the readers of the tenants'
 * scope texts, detail type texts and agents (the stored ones).
 */
export const appPorts = {
  trustedProxies: env.CLAVIX_TRUSTED_PROXIES,
  ide: env.CLAVIX_GRAPHQL_IDE,
  requireClientHeader: env.CLAVIX_REQUIRE_CLIENT_HEADER,
  signInThrottle,
  passkeyThrottle,
  homeRealmThrottle,
  ssoStartThrottle,
  verifyThrottle,
  deviceThrottle,
  scopeTexts: scopeTextsFor,
  detailTexts: detailTextsFor,
  agents: agentsFor,
};
