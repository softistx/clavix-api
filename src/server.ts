import { createApp } from "./app";
import { createConsoleDeps } from "./config/console";
import { env } from "./config/env";
import { signingKeysFor } from "./config/keys";
import { createIssuers } from "./config/oauth";
import { createTenantPurge } from "./config/purge";
import { redis } from "./config/redis";
import { tenantsService } from "./config/tenancy";
import { authFor, claimsFor } from "./config/users";
import { startKeyRotation } from "./keys";
import { drain } from "./modules/auth/outbox";
import { startTenantPurge } from "./modules/tenants/purge-worker";

// Longest wait for a sign-in code mail in flight when the server stops.
const MAIL_DRAIN_MS = 10_000;

// Every active tenant has a key before the first request (a tenant seeded by a
// migration included), then the hourly rotation runs on the Redis queue; with
// no Redis (development) the pass at start is the only one.
await startKeyRotation(
  {
    signingKeysFor,
    activeTenantIds: () => tenantsService.activeIds(),
  },
  redis?.queues.keyRotation,
);

// The trash is emptied daily: a pass at start (it finishes a purge left claimed),
// then one per tick on the Redis queue. Only tenants deleted 30 days ago or more.
await startTenantPurge(createTenantPurge(), redis?.queues.tenantPurge);

// The app with the OAuth/OIDC endpoints of every tenant, serving each tenant's
// stored resources (`resources:create`) beside the built-in userinfo one.
const oauth = createIssuers(authFor, claimsFor);
const app = createApp({
  oauth,
  console: createConsoleDeps(oauth),
}).onStop(async () => {
  // A code mail still in flight is awaited (the requests have already finished), then lost if late.
  if ((await drain(MAIL_DRAIN_MS)) === "timeout")
    console.warn("auth: sign-in code mail still in flight at stop, dropped");
});

// In dev, the URL and the route table; in production, the URL alone. On
// SIGINT and SIGTERM, listen drains the requests in flight, runs the onStop hooks
// (the mail drain; stopTimeout leaves it room) and exits.
app.listen({
  port: env.PORT,
  stopTimeout: MAIL_DRAIN_MS + 2_000,
  onListen: ({ dev, table, url }) =>
    console.log(dev ? table : `listening on ${url}`),
});
