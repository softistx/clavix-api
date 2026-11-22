// Bun's bundler emits the ESM inits of @simplewebauthn/server before its CommonJS require of
// reflect-metadata, so @peculiar/x509 loads tsyringe first; importing the polyfill here, first,
// fixes the order.
import "reflect-metadata";
import { startAgentsPrune } from "@/modules/agents/agents.prune-worker";
import { startAuditRetention } from "@/modules/audit/audit.retention-worker";
import { drain } from "@/modules/auth";
import { startDomainRecheck } from "@/modules/domains/domains.recheck-worker";
import { startKeyRotation } from "@/modules/keys/keys.worker";
import { services } from "@/modules/services";
import { startTenantPurge } from "@/modules/tenants/tenants.purge-worker";
import { startWebhookSecretsPrune } from "@/modules/webhooks/webhooks.secrets-prune-worker";
import { createApp } from "./app";
import { createAgentsPrune } from "./config/agents-prune";
import { appPorts } from "./config/app-ports";
import { createAuditRetention } from "./config/audit-retention";
import { createConsoleDeps } from "./config/console";
import { closeMongo, connectMongo } from "./config/db";
import { domainRecheckDeps } from "./config/domains-job";
import { env } from "./config/env";
import { createGrantsRevoke } from "./config/grants-revoke";
import { keysService } from "./config/keys";
import { noQueue } from "./config/no-ops";
import { createIssuers } from "./config/oauth";
import { createTenantPurge } from "./config/purge";
import { redis } from "./config/redis";
import { clock, warn } from "./config/runtime";
import { instrumentDatabase, telemetry } from "./config/telemetry";
import { tenantsService } from "./config/tenancy";
import { authFor, claimsFor } from "./config/users";
import { createWebhookSecretsPrune, webhookDelivery } from "./config/webhooks";

// Longest wait for a sign-in code mail in flight when the server stops.
const MAIL_DRAIN_MS = 10_000;

// MongoDB opens at start (a bad URI or an unreachable server stops the boot, as
// the health check expects), not at import.
await connectMongo();

// Every active tenant has a key before the first request (a tenant seeded by a
// migration included), then the hourly rotation runs on the Redis queue; with
// no Redis (development) the pass at start is the only one.
await startKeyRotation(
  {
    keys: keysService,
    activeTenantIds: () => tenantsService.activeIds(),
    log: warn,
  },
  redis?.queues.keyRotation ?? noQueue,
);

// The trash is emptied daily: a pass at start (it finishes a purge left claimed),
// then one per tick on the Redis queue. Only tenants deleted 30 days ago or more.
await startTenantPurge(
  createTenantPurge(clock),
  redis?.queues.tenantPurge ?? noQueue,
  warn,
);

// One client span per MongoDB command, when a collector is set (D24).
instrumentDatabase();

// The app with the OAuth/OIDC endpoints of every tenant, serving each tenant's
// stored resources (`resources:create`) beside the built-in userinfo one.
const oauth = createIssuers(authFor, claimsFor);
const consoleDeps = createConsoleDeps(oauth);
// Background workers need a queue: without Redis (development) none runs.
if (redis !== undefined) {
  // Every 6 hours the verified domains' TXT records are read again (A4).
  startDomainRecheck(
    domainRecheckDeps(consoleDeps.directory.findUser),
    redis.queues.domainRecheck,
  );
  // Daily, the agents with no standing grant are deleted: after 24 hours when
  // they never got one, after 7 days otherwise (D10).
  startAgentsPrune(createAgentsPrune(clock), redis.queues.agentsPrune, warn);
  // Daily, the sign-in log and the console activity are cut at each tenant's
  // plan retention, the platform's own events at 400 days (D16).
  startAuditRetention(
    createAuditRetention(clock),
    redis.queues.auditRetention,
    warn,
  );
  // Daily, the rolled webhook secrets past their 24 hours are dropped (D19).
  startWebhookSecretsPrune(
    createWebhookSecretsPrune(clock),
    redis.queues.webhookSecretsPrune,
    warn,
  );
  // A grant revocation that failed at a social replace is retried with backoff
  // (#353).
  services().consent.startRevokeWorker(
    createGrantsRevoke(oauth.serverFor),
    redis.queues.grantsRevoke,
  );
}
const app = createApp({
  ...appPorts,
  oauth,
  console: consoleDeps,
}).onStop(async () => {
  // A code mail still in flight is awaited (the requests have already finished), then lost if late.
  if ((await drain(MAIL_DRAIN_MS)) === "timeout")
    warn("auth: sign-in code mail still in flight at stop, dropped");
  // The requests in flight finish; what waits for a retry stays in Redis for the next process.
  await webhookDelivery.close();
  // Last, so the final spans reach the collector: the backlog is shipped.
  await telemetry.close();
  await closeMongo();
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
