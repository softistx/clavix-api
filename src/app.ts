import { graphql } from "@alxia/graphql";
import { signInThrottle } from "./config/throttle";
import { createBase } from "./http/context";
import { schema } from "./http/schema";
import {
  janusMasking,
  janusPlugin,
  throttleContext,
} from "./modules/auth/plugin";
import type { SignInThrottle } from "./modules/auth/throttle";
import { oauthContext } from "./modules/consent";
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
    signInThrottle?: SignInThrottle | undefined;
  } = {},
) {
  const base = createBase()
    .get("/healthz", ({ reply }) => reply(200, { status: "ok", version }))
    .bodyLimit(BODY_LIMIT);
  return (
    options.oauth === undefined ? base : mountOAuth(base, options.oauth)
  ).plugin((app) =>
    graphql(app, {
      schema,
      ide: "apollo-sandbox",
      plugins: [
        janusPlugin(),
        throttleContext(
          "signInThrottle" in options ? options.signInThrottle : signInThrottle,
        ),
        ...(options.oauth?.serverFor === undefined
          ? []
          : [oauthContext({ serverFor: options.oauth.serverFor })]),
      ],
      maskedErrors: janusMasking,
    }),
  );
}

// The app the server runs.
export const app = createApp();

export type App = typeof app;
