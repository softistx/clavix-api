import { createApp } from "./app";
import { createAgentsPrune } from "./config/agents-prune";
import { createAuditRetention } from "./config/audit-retention";
import { createConsoleDeps } from "./config/console";
import { domainRecheckDeps } from "./config/domains-job";
import { env } from "./config/env";
import { signingKeysFor } from "./config/keys";
import { createIssuers } from "./config/oauth";
import { createTenantPurge } from "./config/purge";
import { redis } from "./config/redis";
import { instrumentDatabase, telemetry } from "./config/telemetry";
import { tenantsService } from "./config/tenancy";
import { authFor, claimsFor } from "./config/users";
import { createWebhookSecretsPrune, webhookDelivery } from "./config/webhooks";
import { startKeyRotation } from "./keys";
import { startAgentsPrune } from "./modules/agents/prune-worker";
import { startAuditRetention } from "./modules/audit/retention-worker";
import { drain } from "./modules/auth/outbox";
import { startDomainRecheck } from "./modules/domains/recheck-worker";
import { startTenantPurge } from "./modules/tenants/purge-worker";
import { startWebhookSecretsPrune } from "./modules/webhooks/secrets-prune-worker";

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

// One client span per MongoDB command, when a collector is set (D24).
instrumentDatabase();

// The app with the OAuth/OIDC endpoints of every tenant, serving each tenant's
// stored resources (`resources:create`) beside the built-in userinfo one.
const oauth = createIssuers(authFor, claimsFor);
const consoleDeps = createConsoleDeps(oauth);
// Every 6 hours the verified domains' TXT records are read again (A4).
startDomainRecheck(
  domainRecheckDeps(consoleDeps.directory.findUser),
  redis?.queues.domainRecheck,
);
// Daily, the agents that registered themselves and still have no grant after
// 7 days are deleted (D10).
startAgentsPrune(createAgentsPrune(), redis?.queues.agentsPrune);
// Daily, the sign-in log and the console activity are cut at each tenant's
// plan retention, the platform's own events at 400 days (D16).
startAuditRetention(createAuditRetention(), redis?.queues.auditRetention);
// Daily, the rolled webhook secrets past their 24 hours are dropped (D19).
startWebhookSecretsPrune(
  createWebhookSecretsPrune(),
  redis?.queues.webhookSecretsPrune,
);
const app = createApp({
  oauth,
  console: consoleDeps,
}).onStop(async () => {
  // A code mail still in flight is awaited (the requests have already finished), then lost if late.
  if ((await drain(MAIL_DRAIN_MS)) === "timeout")
    console.warn("auth: sign-in code mail still in flight at stop, dropped");
  // The requests in flight finish; what waits for a retry stays in Redis for the next process.
  await webhookDelivery.close();
  // Last, so the final spans reach the collector: the backlog is shipped.
  await telemetry.close();
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
