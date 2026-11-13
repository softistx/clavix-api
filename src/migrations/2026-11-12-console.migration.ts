import { defineMigration } from "@softistx/mongo/migrations";
import { env } from "@/config/env";
import { seedConsole, unseedConsole } from "./console-seed";

export const id = "2026-11-12-console";

const origin = () =>
  ({
    scheme: env.CLAVIX_PUBLIC_SCHEME,
    domain: env.CLAVIX_DOMAIN,
    port: env.CLAVIX_PUBLIC_PORT,
  }) as const;

// The console's sign-in: its resource (`https://console.<domain>/api`) and its
// confidential client `console` in the `clavix` tenant, and every tenant linked
// to the platform. Needs the `clavix-tenant` migration, `db:sync` (the OAuth
// and relation collections). The client's secret is printed once, when it is
// created; rotate it later with `clients:create --tenant clavix --name
// "Clavix console" --client-id console --confidential --redirect-uri
// https://console.<domain>/console/auth/callback --rotate-secret`. Down removes the client and the resource.
export const consoleSeed = defineMigration({
  id,
  async up({ db }) {
    const { clientSecret } = await seedConsole(db, origin());
    if (clientSecret !== null && Bun.env.NODE_ENV !== "test") {
      console.log(
        `console client secret (shown once, stored hashed): ${clientSecret}`,
      );
    }
  },
  async down({ db }) {
    await unseedConsole(db, origin());
  },
});
