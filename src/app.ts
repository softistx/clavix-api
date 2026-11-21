import { graphql } from "@softistx/alxia-graphql";
import type { Telemetry } from "@softistx/telemetry";
import { serveLogo } from "./config/branding";
import {
  serveTlsAsk,
  serveWebauthnOrigins,
  TLS_ASK_PATH,
  WEBAUTHN_WELL_KNOWN,
} from "./config/domains-routes";
import { env } from "./config/env";
import { readyz } from "./config/ready";
import { telemetry as appTelemetry } from "./config/telemetry";
import { tenantResolver } from "./config/tenancy";
import { serveAuditExport } from "./console/audit-export/export";
import { useInviteBudget } from "./console/budgets";
import { CONSOLE_EXPORT_PATH, CONSOLE_PATH } from "./console/identity";
import { type ConsoleDeps, useConsole } from "./console/plugin";
import { consoleSchema } from "./console/schema";
import { useWithoutQuotedValues } from "./http/coercion";
import { createBase } from "./http/context";
import { CLIENT_HEADER, useClientHeader } from "./http/csrf";
import { serveReadyz } from "./http/readyz";
import { useSameOriginJson } from "./http/same-origin";
import { schema } from "./http/schema";
import { type ThrottleContext, throttlesOf } from "./http/throttle/context";
import { reportUnexpected } from "./http/unexpected";
import { janusMasking, janusPlugin } from "./modules/auth/auth.plugin";
import { LOGO_PATH } from "./modules/branding/branding.logo-route";
import type { AgentsFor } from "./modules/consent/consent.agent-marker";
import type { DetailTextsFor } from "./modules/consent/consent.detail-labels";
import { oauthContext } from "./modules/consent/consent.plugin";
import type { ScopeTextsFor } from "./modules/consent/consent.scope-labels";
import type { ReadyReport } from "./modules/health";
import { version } from "./modules/health";
import { mountOAuth, type OAuthHandle } from "./oauth/routes";

// The largest body /graphql reads.
export const BODY_LIMIT = 100 * 1024;

/** The highest cost of a console operation (graxia `limits.cost.max`; its default is 5 000). */
export const CONSOLE_MAX_COST = 50_000;

/** The ports `createApp` requires: bound in `src/config/app-ports.ts`. */
export interface AppPorts extends ThrottleContext {
  /** Where the consent page reads the tenants' scope texts. */
  scopeTexts: ScopeTextsFor;
  /** The same for the tenants' detail type texts (the request's `details`). */
  detailTexts: DetailTextsFor;
  /** The tenants' agents, for `OAuthClient.agent` on the hosted pages. */
  agents: AgentsFor;
}

/** What `createApp` takes: the ports, and the entry-point options (the last four default from env or the app's config). */
export interface AppOptions extends AppPorts {
  oauth?: OAuthHandle;
  // The console API (`/console/graphql`, src/console): bearer token, its own
  // schema. Off without it, the route does not exist.
  console?: ConsoleDeps & { schema?: typeof consoleSchema };
  // Where the server spans and logs go (D24); the app's own (`config/telemetry.ts`) by default.
  telemetry?: Telemetry;
  // What `/readyz` checks; Mongo and Redis by default (src/config/ready.ts).
  ready?: () => Promise<ReadyReport>;
  // The GraphQL IDE (Apollo Sandbox) and introspection; `CLAVIX_GRAPHQL_IDE` by default.
  ide?: boolean;
  // Refuse a GraphQL request without `x-clavix-client`; `CLAVIX_REQUIRE_CLIENT_HEADER` by default.
  requireClientHeader?: boolean;
}

/** The base app: context, health and readiness probes, the logo, the TLS ask and the body limit. */
function baseOf(options: AppOptions) {
  return (
    createBase(
      tenantResolver,
      throttlesOf(options),
      options.telemetry ?? appTelemetry,
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
  const ide = options.ide ?? env.CLAVIX_GRAPHQL_IDE;
  const requireClient =
    options.requireClientHeader ?? env.CLAVIX_REQUIRE_CLIENT_HEADER;
  const base = baseOf(options);
  const mounted = (
    options.oauth === undefined ? base : mountOAuth(base, options.oauth)
  ).plugin((app) =>
    graphql(app, {
      schema,
      ide: ide ? "apollo-sandbox" : false,
      sandbox: { initialHeaders: { [CLIENT_HEADER]: "apollo-sandbox" } },
      // Introspection follows the IDE: off wherever the IDE is.
      introspection: ide,
      onUnexpected: reportUnexpected,
      plugins: [
        useClientHeader(requireClient),
        useSameOriginJson(),
        useWithoutQuotedValues(),
        janusPlugin(),
        ...(options.oauth?.serverFor === undefined
          ? []
          : [
              oauthContext(
                { serverFor: options.oauth.serverFor },
                options.scopeTexts,
                options.detailTexts,
                options.agents,
              ),
            ]),
      ],
      ...janusMasking,
    }),
  );
  const consoleOptions = options.console;
  return consoleOptions === undefined
    ? mounted
    : mounted
        .plugin((app) =>
          graphql(app, {
            schema: consoleOptions.schema ?? consoleSchema,
            path: CONSOLE_PATH,
            ide: false,
            // Deliberate: the bearer token is checked first (`useConsole`), so only an authenticated admin introspects.
            introspection: true,
            // The console reads a tenant's stored lists nested (resources > detail types > fields >
            // values): ten items assumed per list put the UI's Applications read at 24 530, over
            // graxia's default 5 000, refused with HTTP 200 and no data. The caller is an
            // authenticated, verified admin, and the limit still refuses a read that multiplies
            // those lists (aliases). Spec: `modules/resources/resources.cost.console.spec.ts`.
            limits: { cost: { max: CONSOLE_MAX_COST } },
            onUnexpected: reportUnexpected,
            plugins: [
              useClientHeader(requireClient),
              // Second, after the client header: aliased invitations are counted before anything runs.
              useInviteBudget(consoleOptions.budgets.inviteCaller),
              useWithoutQuotedValues(),
              useConsole(consoleOptions),
            ],
            ...janusMasking,
          }),
        )
        // The audit export (D17): a stream, so a route beside the GraphQL one.
        .all(CONSOLE_EXPORT_PATH, ({ request }) =>
          serveAuditExport(request, consoleOptions),
        );
}

export type App = ReturnType<typeof createApp>;
