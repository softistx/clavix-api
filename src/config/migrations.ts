import { migrationsOf } from "@/migrations";
import { env } from "./env";

// The migrations `bun run db:migrate` applies, with what the migration context
// does not carry: the public origin of the issuers, and where the console
// client's secret is shown (the deployer's output, once).
export const migrations = migrationsOf({
  origin: {
    scheme: env.CLAVIX_PUBLIC_SCHEME,
    domain: env.CLAVIX_DOMAIN,
    port: env.CLAVIX_PUBLIC_PORT,
  },
  announce: (clientSecret) =>
    console.log(
      `console client secret (shown once, stored hashed): ${clientSecret}`,
    ),
});
