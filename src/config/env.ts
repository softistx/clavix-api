import { defineEnv } from "@alxia/env";
import { z } from "zod";
import { masterKeysProblem } from "./master-keys";

const production = Bun.env.NODE_ENV === "production";

// Required in production; elsewhere `fallback` stands in.
const inProduction = <T extends z.ZodType>(schema: T, fallback: string) =>
  production ? schema : schema.prefault(fallback as never);

// Optional outside production, required in it: an empty value is unset.
const optionalOutsideProduction = <T>(schema: z.ZodType<T, string>) =>
  production
    ? schema
    : z
        .string()
        .transform((value) => value || undefined)
        .pipe(schema.optional())
        .optional();

const trustedProxiesRequired =
  "CLAVIX_TRUSTED_PROXIES is required in production: set the number of reverse proxies in front of the app (0 if none)";

const redisUrl = z
  .string()
  .regex(/^rediss?:\/\/[^/]/, "not a redis:// or rediss:// URL");

// A lowercase DNS name of at least two labels: `clavix.example`, `clavix.localhost`.
const domain = z
  .string()
  .regex(
    /^(?=.{3,253}$)[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/,
    "not a lowercase DNS name with at least two labels",
  );

// The master key that encrypts the signing keys at rest: 32 bytes in standard
// base64 (44 characters), or a comma-separated list of them while it rotates
// (the first seals, any opens; see `master-keys.ts`).
const masterKey = z.string().superRefine((value, ctx) => {
  const problem = masterKeysProblem(value);
  if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
});

const smtpUrl = z
  .string()
  .regex(/^smtps?:\/\/[^/]/, "not an smtp:// or smtps:// URL");

// Development and tests only: public, so it protects nothing. Production
// refuses to start without its own CLAVIX_KEYS_MASTER_KEY.
export const DEV_KEYS_MASTER_KEY = Buffer.from(
  "clavix-dev-only-keys-master-key!",
).toString("base64");

// Read once, at import: a malformed variable stops the process before it
// listens. `.env.example` lists them; Bun loads `.env` on every command.
export const env = defineEnv({
  PORT: z.coerce.number().default(3000),
  // mongodb:// or mongodb+srv://, with the database in its path. Transactions
  // need a replica set.
  MONGO_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "not a MongoDB URI"),
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
  // Sign-in code requests (`requestSignInCode`), on top of janus's 5 per address
  // per 10 min. Per client address and tenant, and per tenant. They need
  // Redis (REDIS_URL): without it there is no such limit.
  CLAVIX_CODE_IP_LIMIT: z.coerce.number().int().min(1).default(20),
  CLAVIX_CODE_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(600),
  CLAVIX_CODE_TENANT_LIMIT: z.coerce.number().int().min(1).default(200),
  CLAVIX_CODE_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  // Passkey sign-in options (`passkeySignInOptions`, anonymous, one token per
  // call), per client address and tenant, and per tenant. Redis only, as above.
  CLAVIX_PASSKEY_IP_LIMIT: z.coerce.number().int().min(1).default(60),
  CLAVIX_PASSKEY_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(600),
  CLAVIX_PASSKEY_TENANT_LIMIT: z.coerce.number().int().min(1).default(600),
  CLAVIX_PASSKEY_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  // Verification mails (`requestEmailVerification`, signed in): per user, then
  // per client address and tenant, and per tenant, on top of janus's 5 per
  // address per 10 min. Redis only, as above.
  CLAVIX_VERIFY_USER_LIMIT: z.coerce.number().int().min(1).default(10),
  CLAVIX_VERIFY_USER_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  CLAVIX_VERIFY_IP_LIMIT: z.coerce.number().int().min(1).default(20),
  CLAVIX_VERIFY_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(600),
  CLAVIX_VERIFY_TENANT_LIMIT: z.coerce.number().int().min(1).default(200),
  CLAVIX_VERIFY_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
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
  CLAVIX_TRUSTED_PROXIES: production
    ? z
        .string({ error: trustedProxiesRequired })
        .regex(/^\d+$/, trustedProxiesRequired)
        .transform(Number)
    : z.coerce.number().int().min(0).default(0),
});
