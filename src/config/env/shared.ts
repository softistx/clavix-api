import { z } from "zod";
import { masterKeysProblem } from "../master-keys";

// Read at call time: the env spec reloads `index.ts` under other values.
export const isProduction = () => Bun.env.NODE_ENV === "production";

// Required in production; elsewhere `fallback` stands in.
export const inProduction = <O>(
  schema: z.ZodType<O, string>,
  fallback: string,
): z.ZodType<O, string | undefined> =>
  isProduction() ? schema : schema.prefault(fallback);

// Optional outside production, required in it: an empty value is unset.
export const optionalOutsideProduction = <T>(schema: z.ZodType<T, string>) =>
  isProduction()
    ? schema
    : z
        .string()
        .transform((value) => value || undefined)
        .pipe(schema.optional())
        .optional();

export const trustedProxiesRequired =
  "CLAVIX_TRUSTED_PROXIES is required in production: set the number of reverse proxies in front of the app (0 if none)";

export const redisUrl = z
  .string()
  .regex(/^rediss?:\/\/[^/]/, "not a redis:// or rediss:// URL");

// A lowercase DNS name of at least two labels: `clavix.example`, `clavix.localhost`.
export const domain = z
  .string()
  .regex(
    /^(?=.{3,253}$)[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/,
    "not a lowercase DNS name with at least two labels",
  );

// The master key that encrypts the signing keys at rest: 32 bytes in standard
// base64 (44 characters), or a comma-separated list of them while it rotates
// (the first seals, any opens; see `master-keys.ts`).
export const masterKey = z.string().superRefine((value, ctx) => {
  const problem = masterKeysProblem(value);
  if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
});

export const smtpUrl = z
  .string()
  .regex(/^smtps?:\/\/[^/]/, "not an smtp:// or smtps:// URL");

// Development and tests only: public, so it protects nothing. Production
// refuses to start without its own CLAVIX_KEYS_MASTER_KEY.
export const DEV_KEYS_MASTER_KEY = Buffer.from(
  "clavix-dev-only-keys-master-key!",
).toString("base64");

// The number of reverse proxies in front of the app: required in production.
export const trustedProxies = (production: boolean) =>
  production
    ? z
        .string({ error: trustedProxiesRequired })
        .regex(/^\d+$/, trustedProxiesRequired)
        .transform(Number)
    : z.coerce.number().int().min(0).default(0);
