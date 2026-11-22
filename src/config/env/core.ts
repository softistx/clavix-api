import { z } from "zod";
import {
  DEV_KEYS_MASTER_KEY,
  domain,
  inProduction,
  isProduction,
  masterKey,
  optionalOutsideProduction,
  redisUrl,
  smtpUrl,
  trustedProxies,
} from "./shared";

// The server, its stores, the issuers, the GraphQL IDE, telemetry and proxies.
export const coreEnv = () => {
  const production = isProduction();
  return {
    PORT: z.coerce.number().default(3000),
    // mongodb:// or mongodb+srv://, with the database in its path. Transactions
    // need a replica set. Required in production; a local one elsewhere, so
    // that code that never queries (`schema:print`) needs no variable. The
    // connection opens on first use (src/config/db.ts).
    MONGO_URI: inProduction(
      z.string().regex(/^mongodb(\+srv)?:\/\//, "not a MongoDB URI"),
      "mongodb://localhost:27017/clavix",
    ),
    // The Redis the tenant cache lives in. Required in production; unset
    // elsewhere, there is no cache (src/config/redis.ts).
    REDIS_URL: optionalOutsideProduction(redisUrl),
    // The apex every tenant issuer hangs under: `<slug>.<CLAVIX_DOMAIN>`.
    CLAVIX_DOMAIN: inProduction(domain, "clavix.localhost"),
    // Encrypts every tenant's signing keys at rest (AES-256-GCM): 32 random
    // bytes in base64, e.g. `openssl rand -base64 32`. Required in production;
    // a public development default elsewhere. Losing it makes the stored keys
    // unreadable: keep it in a secret manager, apart from the database. To
    // rotate it, a comma-separated list: the first key seals, any opens
    // (docs/operations.md, "Rotating the master key").
    CLAVIX_KEYS_MASTER_KEY: inProduction(masterKey, DEV_KEYS_MASTER_KEY),
    // The SMTP server of the platform sender, `no-reply@<CLAVIX_DOMAIN>`
    // (`smtps://user:pass@smtp.example:465`). Required in production; unset
    // elsewhere, the e-mails stay in a memory mailer (src/config/mail.ts).
    CLAVIX_SMTP_URL: optionalOutsideProduction(smtpUrl),
    // The scheme of the issuers built from it; http is refused in production.
    CLAVIX_PUBLIC_SCHEME: z
      .enum(production ? ["https"] : ["https", "http"])
      .default("https"),
    // The port of the issuers, when it is not the scheme's own. Empty is unset.
    CLAVIX_PUBLIC_PORT: z
      .string()
      .transform((value) => (value === "" ? undefined : Number(value)))
      .pipe(z.int().min(1).max(65535).optional())
      .optional(),
    // The GraphQL IDE (Apollo Sandbox) on the hosted `/graphql`, and the
    // schema's introspection with it. The page runs a third-party script on the
    // origin that holds the session cookie, so it is a development tool only:
    // on under `bun dev` (NODE_ENV=development), off elsewhere, and `true` is
    // refused in production.
    CLAVIX_GRAPHQL_IDE: z
      .enum(production ? ["false"] : ["true", "false"])
      .default(Bun.env.NODE_ENV === "development" ? "true" : "false")
      .transform((value) => value === "true"),
    // Refuse a `/graphql` or `/console/graphql` request that carries no
    // `x-clavix-client` header (403 `CLIENT_HEADER_REQUIRED`, before parsing).
    // Off by default so a caller that does not send it yet keeps working; turn it
    // on once clavix-ui's `client-header.ts` (U3) is deployed, then it becomes
    // the default (src/http/csrf.ts).
    CLAVIX_REQUIRE_CLIENT_HEADER: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // Traces and logs (D24): the OTLP/HTTP collector's base URL (`/v1/traces` and
    // `/v1/logs` are appended). Unset, nothing is exported. An empty value is unset.
    OTEL_EXPORTER_OTLP_ENDPOINT: z
      .string()
      .transform((value) => value || undefined)
      .pipe(z.url().optional())
      .optional(),
    // Headers sent to the collector, `key=value` pairs separated by commas (the
    // OpenTelemetry variable of the same name), e.g. an API key.
    OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
    // Caddy's on-demand TLS "ask" (`GET /internal/tls/ask?token=<this>&domain=`,
    // custom domains, A4): the shared secret of that URL, at least 32 characters.
    // Unset, the endpoint does not exist. The route is internal: never expose
    // `/internal/*` publicly (it also refuses a request carrying X-Forwarded-*).
    CLAVIX_TLS_ASK_SECRET: z.string().min(32).optional(),
    // Asks the endpoint answers per minute, all callers together (Redis only).
    CLAVIX_TLS_ASK_LIMIT: z.coerce.number().int().min(1).default(120),
    // How many reverse proxies stand in front of the app. 0 (default): the
    // client address is the connection's. N: it is the entry N places from the
    // right of X-Forwarded-For, which the proxies append to. Required in
    // production, where a wrong 0 behind a proxy rate-limits the proxy's address
    // for everyone (and a wrong N lets a client forge its own): say it, even if 0.
    CLAVIX_TRUSTED_PROXIES: trustedProxies(production),
  };
};
