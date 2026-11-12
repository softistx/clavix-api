import { graphql } from "@alxia/graphql";
import { createBase } from "./http/context";
import { schema } from "./http/schema";
import { version } from "./modules/health";
import { mountOAuth, type OAuthHandle } from "./oauth/routes";

// The largest body /graphql reads.
export const BODY_LIMIT = 100 * 1024;

// `GET /healthz`, the liveness probe (no dependency is checked: the skeleton
// has none), then POST and GET /graphql behind the base's middlewares. The IDE
// follows alxia's dev switch: on under `bun dev`, off otherwise.
export function createApp(options: { oauth?: OAuthHandle } = {}) {
  const base = createBase().get("/healthz", ({ reply }) =>
    reply(200, { status: "ok", version }),
  );
  return (options.oauth === undefined ? base : mountOAuth(base, options.oauth))
    .bodyLimit(BODY_LIMIT)
    .plugin((app) => graphql(app, { schema, ide: "apollo-sandbox" }));
}

// The app the server runs.
export const app = createApp();

export type App = typeof app;
