import { defineEnv } from "@alxia/env";
import { z } from "zod";

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
});
