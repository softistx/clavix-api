import { graphql } from "@alxia/graphql";
import { serveLogo } from "./config/branding";
import { scopeTextsFor } from "./config/resources";
import { passkeyThrottle, signInThrottle } from "./config/throttle";
import { CONSOLE_PATH } from "./console/identity";
import { type ConsoleDeps, useConsole } from "./console/plugin";
import { consoleSchema } from "./console/schema";
import { createBase } from "./http/context";
import { useSameOriginJson } from "./http/same-origin";
import { schema } from "./http/schema";
import type { Throttle } from "./http/throttle/core";
import { janusMasking, janusPlugin } from "./modules/auth/plugin";
import { LOGO_PATH } from "./modules/branding/logo-route";
import { oauthContext } from "./modules/consent";
import type { ScopeTextsFor } from "./modules/consent/scope-labels";
import { version } from "./modules/health";
import { mountOAuth, type OAuthHandle } from "./oauth/routes";

// The largest body /graphql reads.
export const BODY_LIMIT = 100 * 1024;

// `GET /healthz`, the liveness probe (no dependency is checked), the OAuth
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
    // The console API (`/console/graphql`, src/console): bearer token, its own
    // schema. Off without it, the route does not exist.
    // Where the consent page reads the tenants' scope texts; the stored ones by default.
    scopeTexts?: ScopeTextsFor;
    console?: ConsoleDeps & { schema?: typeof consoleSchema };
  } = {},
) {
  const base = createBase(undefined, {
    signInThrottle:
      "signInThrottle" in options ? options.signInThrottle : signInThrottle,
    passkeyThrottle:
      "passkeyThrottle" in options ? options.passkeyThrottle : passkeyThrottle,
  })
    .get("/healthz", ({ reply }) => reply(200, { status: "ok", version }))
    .all(LOGO_PATH, ({ request }) => serveLogo(request))
    .bodyLimit(BODY_LIMIT);
  const mounted = (
    options.oauth === undefined ? base : mountOAuth(base, options.oauth)
  ).plugin((app) =>
    graphql(app, {
      schema,
      ide: "apollo-sandbox",
      plugins: [
        useSameOriginJson(),
        janusPlugin(),
        ...(options.oauth?.serverFor === undefined
          ? []
          : [
              oauthContext(
                { serverFor: options.oauth.serverFor },
                options.scopeTexts ?? scopeTextsFor,
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
          plugins: [useConsole(consoleOptions)],
          maskedErrors: janusMasking,
        }),
      );
}

// The app the server runs.
export const app = createApp();

export type App = typeof app;
