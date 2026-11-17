import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { getCollection } from "@softistx/mongo";
import { defineMigration } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { CONSOLE_CLIENT_ID } from "@/console/identity";
import { partitionOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { tenants } from "@/modules/tenants/tenants.model";

export const id = "2026-11-17-console-par-dpop";

/**
 * Sets only the two flags on the stored `console` client: its name, redirect
 * URIs, grants and secret stay as they are (a URI added later is kept). A
 * missing client (not seeded yet) is left alone.
 */
async function setConsoleClientFlags(db: Db, on: boolean): Promise<void> {
  const tenant = await getCollection(db, tenants).findFirst({
    slug: PLATFORM_TENANT_SLUG,
  });
  if (tenant === undefined) return;
  const store = createMongoOAuth(db, { partition: partitionOf(tenant._id) });
  const client = await store.findClient(CONSOLE_CLIENT_ID);
  if (client === null) return;
  const {
    requirePushedAuthorizationRequests: _par,
    dpopBoundAccessTokens: _dpop,
    ...rest
  } = client;
  await store.upsertClient({
    ...rest,
    ...(on
      ? {
          requirePushedAuthorizationRequests: true,
          dpopBoundAccessTokens: true,
        }
      : {}),
  });
}

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
export async function requireParAndDpopOnConsole(db: Db): Promise<boolean> {
  await setConsoleClientFlags(db, true);
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
export async function relaxParAndDpopOnConsole(db: Db): Promise<void> {
  await setConsoleClientFlags(db, false);
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
    await requireParAndDpopOnConsole(db);
  },
  async down({ db }) {
    await relaxParAndDpopOnConsole(db);
  },
});
