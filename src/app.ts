import type { Telemetry } from "@softistx/telemetry";
import { LOGO_PATH } from "@/modules/branding";
import type {
  AgentsFor,
  DetailTextsFor,
  ScopeTextsFor,
} from "@/modules/consent";
import type { ReadyReport } from "@/modules/health";
import { version } from "@/modules/health";
import { serveLogo } from "./config/branding";
import {
  serveTlsAsk,
  serveWebauthnOrigins,
  TLS_ASK_PATH,
  WEBAUTHN_WELL_KNOWN,
} from "./config/domains-routes";
import { readyz } from "./config/ready";
import { telemetry as appTelemetry } from "./config/telemetry";
import { tenantResolver } from "./config/tenancy";
import { serveAuditExport } from "./console/audit-export/export";
import { mountConsoleGraphql } from "./console/graphql-mount";
import { CONSOLE_EXPORT_PATH } from "./console/identity";
import type { ConsoleDeps } from "./console/plugin";
import type { consoleSchema } from "./console/schema";
import { createBase } from "./http/context";
import { mountHostedGraphql } from "./http/graphql-mount";
import { serveReadyz } from "./http/readyz";
import { type ThrottleContext, throttlesOf } from "./http/throttle/context";
import { mountOAuth, type OAuthHandle } from "./oauth/routes";

// The largest body /graphql reads.
export const BODY_LIMIT = 100 * 1024;

/** The ports `createApp` requires: bound in `src/config/app-ports.ts`. */
export interface AppPorts extends ThrottleContext {
  /** How many reverse proxies stand in front of the app (`CLAVIX_TRUSTED_PROXIES`). */
  trustedProxies: number;
  /** The GraphQL IDE (Apollo Sandbox) and introspection (`CLAVIX_GRAPHQL_IDE`). */
  ide: boolean;
  /** Refuse a GraphQL request without `x-clavix-client` (`CLAVIX_REQUIRE_CLIENT_HEADER`). */
  requireClientHeader: boolean;
  /** Where the consent page reads the tenants' scope texts. */
  scopeTexts: ScopeTextsFor;
  /** The same for the tenants' detail type texts (the request's `details`). */
  detailTexts: DetailTextsFor;
  /** The tenants' agents, for `OAuthClient.agent` on the hosted pages. */
  agents: AgentsFor;
}

/** What `createApp` takes: the ports, and the entry-point options (their defaults are the app's config). */
export interface AppOptions extends AppPorts {
  oauth?: OAuthHandle;
  // The console API (`/console/graphql`, src/console): bearer token, its own
  // schema. Off without it, the route does not exist.
  console?: ConsoleDeps & { schema?: typeof consoleSchema };
  // Where the server spans and logs go (D24); the app's own (`config/telemetry.ts`) by default.
  telemetry?: Telemetry;
  // What `/readyz` checks; Mongo and Redis by default (src/config/ready.ts).
  ready?: () => Promise<ReadyReport>;
}

/** The base app: context, health and readiness probes, the logo, the TLS ask and the body limit. */
function baseOf(options: AppOptions) {
  return (
    createBase(
      tenantResolver,
      throttlesOf(options),
      options.telemetry ?? appTelemetry,
      options.trustedProxies,
    )
      .get("/healthz", ({ reply }) => reply(200, { status: "ok", version }))
      // Readiness: Mongo and Redis answer, 503 otherwise (the orchestrator stops routing here).
      .all("/readyz", ({ request }) =>
        serveReadyz(request, options.ready ?? readyz),
      )
      .all(LOGO_PATH, ({ request }) => serveLogo(request))
      // Caddy's on-demand TLS ask: internal, secret-guarded (src/modules/domains/domains.tls-ask.ts).
      .all(TLS_ASK_PATH, ({ request }) => serveTlsAsk(request))
      .all(WEBAUTHN_WELL_KNOWN, ({ request }) => serveWebauthnOrigins(request))
      .bodyLimit(BODY_LIMIT)
  );
}

// `GET /healthz`, the liveness probe (no dependency is checked), `GET /readyz`, the OAuth
// endpoints when `oauth` is given (the issuers of src/oauth, which
// src/server.ts passes), then POST and GET /graphql behind the base's
// middlewares. The body limit is declared before the OAuth routes, since it
// applies only to the routes declared after it. The IDE follows alxia's dev
// switch: on under `bun dev`, off otherwise.
export function createApp(options: AppOptions) {
  const { requireClientHeader: requireClient } = options;
  const base = baseOf(options);
  const mounted = (
    options.oauth === undefined ? base : mountOAuth(base, options.oauth)
  ).plugin((app) => mountHostedGraphql(app, options));
  const consoleOptions = options.console;
  return consoleOptions === undefined
    ? mounted
    : mounted
        .plugin((app) =>
          mountConsoleGraphql(app, consoleOptions, requireClient),
        )
        // The audit export (D17): a stream, so a route beside the GraphQL one.
        .all(CONSOLE_EXPORT_PATH, ({ request }) =>
          serveAuditExport(request, consoleOptions),
        );
}

export type App = ReturnType<typeof createApp>;
