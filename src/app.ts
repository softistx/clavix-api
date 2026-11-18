import { graphql } from "@alxia/graphql";
import { agentsFor } from "./config/agent-clients";
import { serveLogo } from "./config/branding";
import {
  serveTlsAsk,
  serveWebauthnOrigins,
  TLS_ASK_PATH,
  WEBAUTHN_WELL_KNOWN,
} from "./config/domains-routes";
import { readyz } from "./config/ready";
import { detailTextsFor, scopeTextsFor } from "./config/resources";
import {
  deviceThrottle,
  passkeyThrottle,
  signInThrottle,
  verifyThrottle,
} from "./config/throttle";
import { CONSOLE_PATH } from "./console/identity";
import { type ConsoleDeps, useConsole } from "./console/plugin";
import { consoleSchema } from "./console/schema";
import { useWithoutQuotedValues } from "./http/coercion";
import { createBase } from "./http/context";
import { useSameOriginJson } from "./http/same-origin";
import { schema } from "./http/schema";
import type { Throttle } from "./http/throttle/core";
import { janusMasking, janusPlugin } from "./modules/auth/plugin";
import type { VerificationThrottle } from "./modules/auth/verification-throttle";
import { LOGO_PATH } from "./modules/branding/logo-route";
import { oauthContext } from "./modules/consent";
import type { AgentsFor } from "./modules/consent/agent-marker";
import type { DetailTextsFor } from "./modules/consent/detail-labels";
import type { DeviceThrottle } from "./modules/consent/device-throttle";
import type { ScopeTextsFor } from "./modules/consent/scope-labels";
import { version } from "./modules/health";
import type { ReadyReport } from "./modules/health/ready";
import { mountOAuth, type OAuthHandle } from "./oauth/routes";

// The largest body /graphql reads.
export const BODY_LIMIT = 100 * 1024;

// `GET /healthz`, the liveness probe (no dependency is checked), `GET /readyz`, the OAuth
// endpoints when `oauth` is given (the issuers of src/oauth, which
// src/server.ts passes), then POST and GET /graphql behind the base's
// middlewares. The body limit is declared before the OAuth routes, since it
// applies only to the routes declared after it. The IDE follows alxia's dev
// switch: on under `bun dev`, off otherwise.
export function createApp(
  options: {
    oauth?: OAuthHandle;
    // The per-IP and per-tenant sign-in code limits; the app's Redis ones by
    // default (none without REDIS_URL).
    signInThrottle?: Throttle | undefined;
    // The same for `passkeySignInOptions`.
    passkeyThrottle?: Throttle | undefined;
    // The same for `requestEmailVerification` (per user too).
    verifyThrottle?: VerificationThrottle | undefined;
    // The same for the device verification page's code lookups.
    deviceThrottle?: DeviceThrottle | undefined;
    // The console API (`/console/graphql`, src/console): bearer token, its own
    // schema. Off without it, the route does not exist.
    console?: ConsoleDeps & { schema?: typeof consoleSchema };
    // Where the consent page reads the tenants' scope texts; the stored ones by default.
    scopeTexts?: ScopeTextsFor;
    // The same for the tenants' detail type texts (the request's `details`).
    detailTexts?: DetailTextsFor;
    // The tenants' agents, for `OAuthClient.agent` on the hosted pages; the stored ones by default.
    agents?: AgentsFor;
    // What `/readyz` checks; Mongo and Redis by default (src/config/ready.ts).
    ready?: () => Promise<ReadyReport>;
  } = {},
) {
  const base = createBase(undefined, {
    signInThrottle:
      "signInThrottle" in options ? options.signInThrottle : signInThrottle,
    passkeyThrottle:
      "passkeyThrottle" in options ? options.passkeyThrottle : passkeyThrottle,
    verifyThrottle:
      "verifyThrottle" in options ? options.verifyThrottle : verifyThrottle,
    deviceThrottle:
      "deviceThrottle" in options ? options.deviceThrottle : deviceThrottle,
  })
    .get("/healthz", ({ reply }) => reply(200, { status: "ok", version }))
    // Readiness: Mongo and Redis answer, 503 otherwise (the orchestrator stops routing here).
    .all("/readyz", async ({ request }) => {
      if (request.method !== "GET") return new Response(null, { status: 404 });
      const report = await (options.ready ?? readyz)();
      return Response.json(report, {
        status: report.status === "ok" ? 200 : 503,
        headers: { "cache-control": "no-store" },
      });
    })
    .all(LOGO_PATH, ({ request }) => serveLogo(request))
    // Caddy's on-demand TLS ask: internal, secret-guarded (src/modules/domains/tls-ask.ts).
    .all(TLS_ASK_PATH, ({ request }) => serveTlsAsk(request))
    .all(WEBAUTHN_WELL_KNOWN, ({ request }) => serveWebauthnOrigins(request))
    .bodyLimit(BODY_LIMIT);
  const mounted = (
    options.oauth === undefined ? base : mountOAuth(base, options.oauth)
  ).plugin((app) =>
    graphql(app, {
      schema,
      ide: "apollo-sandbox",
      plugins: [
        useSameOriginJson(),
        useWithoutQuotedValues(),
        janusPlugin(),
        ...(options.oauth?.serverFor === undefined
          ? []
          : [
              oauthContext(
                { serverFor: options.oauth.serverFor },
                options.scopeTexts ?? scopeTextsFor,
                options.detailTexts ?? detailTextsFor,
                options.agents ?? agentsFor,
              ),
            ]),
      ],
      maskedErrors: janusMasking,
    }),
  );
  const consoleOptions = options.console;
  return consoleOptions === undefined
    ? mounted
    : mounted.plugin((app) =>
        graphql(app, {
          schema: consoleOptions.schema ?? consoleSchema,
          path: CONSOLE_PATH,
          ide: false,
          plugins: [useWithoutQuotedValues(), useConsole(consoleOptions)],
          maskedErrors: janusMasking,
        }),
      );
}

// The app the server runs.
export const app = createApp();

export type App = typeof app;
