// Shared by the k6 scripts: the target, the tenants and the Caddy-like headers.
// The tenant is the Host header (`<slug>.<domain>`); the api sits behind one proxy
// (CLAVIX_TRUSTED_PROXIES=1), so each request carries what Caddy would add.
import { SharedArray } from "k6/data";

export const BASE = __ENV.BASE_URL || "http://api:3000";
export const SEED = new SharedArray("seed", () => [
  JSON.parse(open(__ENV.SEED_FILE || "/load/seed.json")),
]);
export const domain = SEED[0].domain;
export const tenants = SEED[0].tenants;

export const duration = __ENV.DURATION || "60s";
export const warmup = __ENV.WARMUP || "10s";

export function headers(slug, extra) {
  // A pool of 250 client addresses, so no per-address limit decides the run.
  const ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
  return Object.assign(
    {
      Host: `${slug}.${domain}`,
      "X-Forwarded-For": ip,
      "X-Forwarded-Proto": "https",
    },
    extra || {},
  );
}

export function pickTenant() {
  return tenants[Math.floor(Math.random() * tenants.length)];
}

// One scenario at a fixed arrival rate: a short warm-up (not measured: its
// requests carry the `warmup` tag the thresholds ignore), then the measured run.
// `withWarmup: false` skips the warm-up (a script whose VUs hold state, as token.js).
export function scenario(rate, exec, vus, withWarmup = true) {
  const warm = {
    warm: {
      executor: "constant-arrival-rate",
      rate: Math.round(rate / 4),
      timeUnit: "1s",
      duration: warmup,
      preAllocatedVUs: Math.ceil(vus / 2),
      maxVUs: vus,
      exec,
      tags: { phase: "warmup" },
    },
  };
  if (!withWarmup) delete warm.warm;
  return Object.assign(warm, {
    run: {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration,
      startTime: withWarmup ? warmup : "0s",
      preAllocatedVUs: vus,
      maxVUs: vus,
      exec,
      tags: { phase: "run" },
    },
  });
}
