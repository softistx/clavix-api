import { graphql } from "@alxia/graphql";
import {
  CONSENT_GRAPHQL_PATH,
  type ConsentHandle,
} from "./consent/consent-yoga";
import { createBase } from "./http/context";
import { schema } from "./http/schema";
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
  options: { oauth?: OAuthHandle; consent?: ConsentHandle } = {},
) {
  const base = createBase()
    .get("/healthz", ({ reply }) => reply(200, { status: "ok", version }))
    .bodyLimit(BODY_LIMIT);
  const withOAuth =
    options.oauth === undefined ? base : mountOAuth(base, options.oauth);
  const { consent } = options;
  // The hosted consent page's API: its own Yoga server until slice E1's /graphql takes its parts in.
  return (
    consent === undefined
      ? withOAuth
      : withOAuth.all(CONSENT_GRAPHQL_PATH, ({ request }) =>
          consent.fetch(request),
        )
  ).plugin((app) => graphql(app, { schema, ide: "apollo-sandbox" }));
}

// The app the server runs.
export const app = createApp();

export type App = typeof app;
