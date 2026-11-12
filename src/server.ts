import { createApp } from "./app";
import { env } from "./config/env";
import { signingKeysFor } from "./config/keys";
import { createIssuers } from "./config/oauth";
import { redis } from "./config/redis";
import { tenantsService } from "./config/tenancy";
import { authFor, claimsFor, janusIssuers } from "./config/users";
import { createConsentYoga } from "./consent/consent-yoga";
import { startKeyRotation } from "./keys";

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

// The app with the OAuth/OIDC endpoints of every tenant (no resource is
// configured yet, so no /authorize succeeds until the tenants' resources, M2).
const oauth = createIssuers(authFor, claimsFor);
const app = createApp({
  oauth,
  consent: createConsentYoga({ issuers: oauth, janusIssuers }),
});

// In dev, the URL and the route table; in production, the URL alone. On
// SIGINT and SIGTERM, listen drains the requests in flight and exits.
app.listen({
  port: env.PORT,
  onListen: ({ dev, table, url }) =>
    console.log(dev ? table : `listening on ${url}`),
});
