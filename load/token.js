// POST /token at 200 req/s for 60 s across the seeded tenants: the refresh_token
// grant (rotation: each VU walks its own chain, one request at a time).
// client_credentials is not offered by Clavix (unsupported_grant_type), so it is
// only probed once in `setup` (docs/operations.md, "Load test").

import { check, sleep } from "k6";
import http from "k6/http";
import { BASE, headers, scenario, tenants } from "./lib.js";

const RATE = Number(__ENV.RATE || 200);
const VUS = Number(__ENV.VUS || 100);

// client_credentials is not offered yet (unsupported_grant_type): its scenario
// is skipped unless CLIENT_CREDENTIALS=1 (needs a confidential client in the
// seed and the grant on the server). Same 200 req/s and p95 < 150 ms target.
const CC = __ENV.CLIENT_CREDENTIALS === "1";

export const options = {
  scenarios: Object.assign(
    scenario(RATE, "refresh", VUS, false),
    CC
      ? {
          cc: {
            executor: "constant-arrival-rate",
            rate: RATE,
            timeUnit: "1s",
            duration: __ENV.DURATION || "60s",
            preAllocatedVUs: VUS,
            maxVUs: VUS,
            exec: "clientCredentials",
            tags: { phase: "run", grant: "client_credentials" },
          },
        }
      : {},
  ),
  thresholds: {
    dropped_iterations: ["count==0"],
    "http_req_duration{phase:run}": ["p(95)<150"],
    "http_req_failed{phase:run}": ["rate==0"],
    "checks{phase:run}": ["rate==1"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// One chain per VU: tenants have two chains each, VU n takes chain n.
const chains = [];
for (const t of tenants) {
  for (const c of t.chains) {
    chains.push({ slug: t.slug, clientId: c.clientId, token: c.token });
  }
}

export function setup() {
  const t = tenants[0];
  const res = http.post(
    `${BASE}/token`,
    { grant_type: "client_credentials", client_id: t.chains[0].clientId },
    { headers: headers(t.slug) },
  );
  // Warm: the api builds a tenant's server on its first request. (No warm-up
  // scenario here: its VUs would rotate the chains the measured VUs then reuse.)
  for (const tenant of tenants) {
    http.get(`${BASE}/.well-known/openid-configuration`, {
      headers: headers(tenant.slug),
    });
  }
  console.log(`client_credentials probe: ${res.status} ${res.body}`);
}

let mine;
export function refresh() {
  mine = mine || chains[(__VU - 1) % chains.length];
  const res = http.post(
    `${BASE}/token`,
    {
      grant_type: "refresh_token",
      client_id: mine.clientId,
      refresh_token: mine.token,
    },
    { headers: headers(mine.slug) },
  );
  const ok = check(res, {
    200: (r) => r.status === 200,
  });
  // Think time: it keeps ~50 VUs busy at 200 req/s (each one walks its own
  // chain), so the run spreads over ~50 chains instead of the 2 VUs that a
  // 3 ms request would need.
  sleep(0.25);
  if (ok) mine.token = res.json("refresh_token");
  else if (!mine.failed) {
    mine.failed = true;
    console.error(
      `first failure of ${mine.slug}/${mine.clientId}: ${res.status} ${res.body}`,
    );
  }
}

// Basic client authentication: the seed must register a confidential client
// (`clientSecret` in seed.json) once the grant ships.
export function clientCredentials() {
  const t = tenants[Math.floor(Math.random() * tenants.length)];
  const res = http.post(
    `${BASE}/token`,
    { grant_type: "client_credentials", scope: "read" },
    {
      headers: headers(t.slug),
      auth: `${t.confidential.clientId}:${t.confidential.secret}`,
    },
  );
  check(res, { 200: (r) => r.status === 200 });
}
