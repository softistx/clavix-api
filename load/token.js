// POST /token at 200 req/s for 60 s across the seeded tenants: the refresh_token
// grant (rotation: each VU walks its own chain, one request at a time).
// client_credentials is not offered by Clavix (unsupported_grant_type), so it is
// only probed once in `setup` (docs/operations.md, "Load test").

import { check, sleep } from "k6";
import http from "k6/http";
import { BASE, headers, scenario, tenants } from "./lib.js";

const RATE = Number(__ENV.RATE || 200);
const VUS = Number(__ENV.VUS || 100);

export const options = {
  scenarios: scenario(RATE, "refresh", VUS, false),
  thresholds: {
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
