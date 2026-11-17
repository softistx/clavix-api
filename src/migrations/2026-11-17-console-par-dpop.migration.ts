import { getCollection } from "@softistx/mongo";
import { defineMigration } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { registerClient } from "@/clients/register-client";
import { env } from "@/config/env";
import { CONSOLE_CLIENT_ID, consoleRedirectUri } from "@/console/identity";
import type { PublicOrigin } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { tenants } from "@/modules/tenants/tenants.model";
import { NAME } from "./console-seed";

export const id = "2026-11-17-console-par-dpop";

const origin = (): PublicOrigin => ({
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
});

/**
 * M3 plan, decision 2: the console now signs in with PAR and DPoP (ES256), so
 * the `clavix` tenant requires both. Marks the `console` client as pushing its
 * authorization requests and binding its tokens, and sets the tenant's policy
 * to `par.required` and `dpop.required`. Deploy clavix-ui first or together:
 * a console that does not push or prove is refused once this has run.
 * Idempotent: the client is re-registered with the same flags (its secret and
 * grants are kept), and the tenant is written (version bumped, so the resolver
 * drops its cache) only when a flag is still off. Returns whether the tenant
 * changed.
 */
export async function requireParAndDpopOnConsole(
  db: Db,
  publicOrigin: PublicOrigin,
): Promise<boolean> {
  const collection = getCollection(db, tenants);
  const findTenant = (slug: string) => collection.findFirst({ slug });
  await registerClient(
    { db, findTenant },
    {
      tenant: PLATFORM_TENANT_SLUG,
      name: NAME,
      clientId: CONSOLE_CLIENT_ID,
      redirectUris: [consoleRedirectUri(publicOrigin)],
      type: "confidential",
      requirePar: true,
      dpopBound: true,
    },
  );
  const { modifiedCount } = await db.collection("tenants").updateOne(
    {
      slug: PLATFORM_TENANT_SLUG,
      $or: [
        { "oauth.par.required": { $ne: true } },
        { "oauth.dpop.required": { $ne: true } },
      ],
    },
    {
      $set: {
        "oauth.par.required": true,
        "oauth.dpop.required": true,
        updatedAt: new Date(),
      },
      $inc: { version: 1 },
    },
  );
  return modifiedCount > 0;
}

/** Undoes {@link requireParAndDpopOnConsole}: the console client and the `clavix` tenant stop requiring them. */
export async function relaxParAndDpopOnConsole(
  db: Db,
  publicOrigin: PublicOrigin,
): Promise<void> {
  await registerClient(
    {
      db,
      findTenant: (slug) => getCollection(db, tenants).findFirst({ slug }),
    },
    {
      tenant: PLATFORM_TENANT_SLUG,
      name: NAME,
      clientId: CONSOLE_CLIENT_ID,
      redirectUris: [consoleRedirectUri(publicOrigin)],
      type: "confidential",
      requirePar: false,
      dpopBound: false,
    },
  );
  await db.collection("tenants").updateOne(
    { slug: PLATFORM_TENANT_SLUG },
    {
      $set: {
        "oauth.par.required": false,
        "oauth.dpop.required": false,
        updatedAt: new Date(),
      },
      $inc: { version: 1 },
    },
  );
}

// Needs the `console` and `oauth-policy` migrations first. Down relaxes both
// again (a console still on PAR and DPoP keeps working).
export const consolePushedDpopMigration = defineMigration({
  id,
  async up({ db }) {
    await requireParAndDpopOnConsole(db, origin());
  },
  async down({ db }) {
    await relaxParAndDpopOnConsole(db, origin());
  },
});
