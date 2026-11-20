// GET /jwks.json and GET /.well-known/openid-configuration, 1 000 req/s each
// (2 000 req/s together) for 60 s across the seeded tenants.

import { check } from "k6";
import http from "k6/http";
import { BASE, headers, pickTenant, scenario } from "./lib.js";

const RATE = Number(__ENV.RATE || 1000);
const VUS = Number(__ENV.VUS || 150);

function prefixed(prefix, scenarios) {
  const out = {};
  for (const [name, value] of Object.entries(scenarios)) {
    out[`${prefix}_${name}`] = Object.assign({}, value, {
      tags: Object.assign({}, value.tags, { endpoint: prefix }),
    });
  }
  return out;
}

export const options = {
  scenarios: Object.assign(
    prefixed("jwks", scenario(RATE, "jwks", VUS)),
    prefixed("discovery", scenario(RATE, "discovery", VUS)),
  ),
  thresholds: {
    dropped_iterations: ["count==0"],
    "http_req_duration{phase:run,endpoint:jwks}": ["p(95)<20"],
    "http_req_duration{phase:run,endpoint:discovery}": ["p(95)<20"],
    "http_req_failed{phase:run}": ["rate==0"],
    "checks{phase:run}": ["rate==1"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

function get(path, endpoint) {
  const t = pickTenant();
  const res = http.get(`${BASE}${path}`, {
    headers: headers(t.slug),
    tags: { endpoint },
  });
  check(res, { 200: (r) => r.status === 200 });
}

export function jwks() {
  get("/jwks.json", "jwks");
}

export function discovery() {
  get("/.well-known/openid-configuration", "discovery");
}
