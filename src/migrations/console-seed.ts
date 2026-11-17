import { createMongoRelations } from "@softistx/janus-mongo";
import { deleteClient } from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { getCollection } from "@softistx/mongo";
import type { Db } from "mongodb";
import { registerClient } from "@/clients/register-client";
import { createAccess } from "@/console/access";
import {
  CONSOLE_CLIENT_ID,
  CONSOLE_SCOPES,
  consoleAudience,
  consoleRedirectUri,
} from "@/console/identity";
import { registerResource } from "@/modules/resources/register-resource";
import { resources } from "@/modules/resources/resources.model";
import { scopes } from "@/modules/resources/scopes.model";
import {
  issuerOf,
  type PublicOrigin,
  partitionOf,
} from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { tenants } from "@/modules/tenants/tenants.model";

export const NAME = "Clavix console";

/**
 * Seeds what the console signs in with, in the `clavix` tenant: the console
 * API as a resource (`aud` `https://console.<domain>/api`) and the console as a
 * confidential client. Idempotent (a re-run changes nothing, and keeps the
 * client's secret). Answers the secret when the client was just created, shown
 * once: janus keeps only its hash.
 */
export async function seedConsole(
  db: Db,
  origin: PublicOrigin,
): Promise<{ clientSecret: string | null }> {
  const collection = getCollection(db, tenants);
  const findTenant = (slug: string) => collection.findFirst({ slug });
  await registerResource(
    {
      collection: getCollection(db, resources),
      scopes: getCollection(db, scopes),
      findTenant,
      issuerOf: (slug) => issuerOf(slug, origin),
    },
    {
      tenant: PLATFORM_TENANT_SLUG,
      uri: consoleAudience(origin),
      name: NAME,
      scopes: CONSOLE_SCOPES,
    },
  );
  const client = await registerClient(
    { db, findTenant },
    {
      tenant: PLATFORM_TENANT_SLUG,
      name: NAME,
      clientId: CONSOLE_CLIENT_ID,
      redirectUris: [consoleRedirectUri(origin)],
      type: "confidential",
    },
  );
  // Every tenant is linked to the platform, so a platform role carries over
  // (new tenants are linked when created, `config/tenancy.ts`).
  const access = createAccess(createMongoRelations(db));
  for (const tenant of await collection.findMany()) {
    await access.linkTenant(partitionOf(tenant._id));
  }
  return { clientSecret: client.clientSecret };
}

/** Removes the console client and resource from the `clavix` tenant. */
export async function unseedConsole(db: Db, origin: PublicOrigin) {
  const tenant = await getCollection(db, tenants).findFirst({
    slug: PLATFORM_TENANT_SLUG,
  });
  if (tenant === undefined) return;
  const partition = partitionOf(tenant._id);
  // The console client has live sessions: its grants and tokens go with it.
  await deleteClient(createMongoOAuth(db, { partition }), CONSOLE_CLIENT_ID, {
    now: new Date(),
  });
  await db
    .collection("resources")
    .deleteMany({ tenantId: tenant._id, uri: consoleAudience(origin) });
}
