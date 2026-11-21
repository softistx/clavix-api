import { migrationsOf } from "@/migrations";
import { env } from "./env";

// The migrations `bun run db:migrate` applies, with what the migration context
// does not carry: the public origin of the issuers, and where the console
// client's secret is shown. The script passes `announce` (its output is the
// deployer's, once); config prints nothing itself.
export const migrationsWith = (announce: (clientSecret: string) => void) =>
  migrationsOf({
    origin: {
      scheme: env.CLAVIX_PUBLIC_SCHEME,
      domain: env.CLAVIX_DOMAIN,
      port: env.CLAVIX_PUBLIC_PORT,
    },
    announce,
  });
