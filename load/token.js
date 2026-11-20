// POST /token at 200 req/s for 60 s across the seeded tenants: the refresh_token
// grant (rotation: each VU walks its own chain, one request at a time).
// The client_credentials grant: a confidential client per tenant (seeded with
// the resource opted in), Basic authentication, no refresh and no user. It runs
// beside the refresh grant (docs/operations.md, "Load test").

import { check, sleep } from "k6";
import encoding from "k6/encoding";
import http from "k6/http";
import { BASE, headers, scenario, tenants } from "./lib.js";

const RATE = Number(__ENV.RATE || 200);
const VUS = Number(__ENV.VUS || 100);

// The client_credentials scenario is on; CLIENT_CREDENTIALS=0 skips it (a
// seed made before the grant shipped has no confidential client). Same
// 200 req/s and p95 < 150 ms target.
const CC = __ENV.CLIENT_CREDENTIALS !== "0";
const RESOURCE = "https://api.load.test/v1";

// k6's `auth` option takes credentials from the URL, not from params: build the
// Basic header by hand.
const basic = (c) => ({
  Authorization: `Basic ${encoding.b64encode(`${c.clientId}:${c.secret}`)}`,
});

const refreshScenario = scenario(RATE, "refresh", VUS, false);
refreshScenario.run.tags.grant = "refresh";

export const options = {
  scenarios: Object.assign(
    refreshScenario,
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
    "http_req_duration{grant:refresh}": ["p(95)<150"],
    ...(CC
      ? { "http_req_duration{grant:client_credentials}": ["p(95)<150"] }
      : {}),
    "http_req_failed{phase:run}": ["rate==0"],
    "checks{phase:run}": ["rate==1"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// One chain per VU: VU n takes chain n. The client_credentials scenario takes VU ids
// too, so the ids of the refresh VUs reach 2 x VUS: the seed makes 4 chains per
// tenant (LOAD_CHAINS) so that no two VUs share one.
const chains = [];
for (const t of tenants) {
  for (const c of t.chains) {
    chains.push({ slug: t.slug, clientId: c.clientId, token: c.token });
  }
}

export function setup() {
  const t = tenants[0];
  const res = CC
    ? http.post(
        `${BASE}/token`,
        { grant_type: "client_credentials", resource: RESOURCE, scope: "read" },
        {
          headers: headers(t.slug, basic(t.confidential)),
        },
      )
    : null;
  // Warm: the api builds a tenant's server on its first request. (No warm-up
  // scenario here: its VUs would rotate the chains the measured VUs then reuse.)
  for (const tenant of tenants) {
    http.get(`${BASE}/.well-known/openid-configuration`, {
      headers: headers(tenant.slug),
    });
  }
  if (res !== null) {
    console.log(`client_credentials probe: ${res.status} ${res.body}`);
  }
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

// Basic client authentication with the seed's confidential client
// (`confidential` of each tenant in seed.json).
export function clientCredentials() {
  const t = tenants[Math.floor(Math.random() * tenants.length)];
  const res = http.post(
    `${BASE}/token`,
    { grant_type: "client_credentials", resource: RESOURCE, scope: "read" },
    {
      headers: headers(t.slug, basic(t.confidential)),
    },
  );
  check(res, { 200: (r) => r.status === 200 });
}
