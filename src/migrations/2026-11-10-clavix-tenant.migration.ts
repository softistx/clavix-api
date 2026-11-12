import { getCollection } from "@softistx/mongo";
import { defineMigration } from "@softistx/mongo/migrations";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { tenants } from "@/modules/tenants/tenants.model";

export const id = "2026-11-10-clavix-tenant";

// The platform's own tenant, `clavix`: Clavix signs its console in through
// itself. Written only when no live tenant has the slug, so a second run (or a
// database that already has it) keeps the one tenant, its `_id` and its name
// as an operator renamed it. Down removes it for good.
export const clavixTenant = defineMigration({
  id,
  async up({ db, session }) {
    const collection = getCollection(db, tenants).withSession(session);
    if (await collection.exists({ slug: PLATFORM_TENANT_SLUG })) return;
    // The runner's lock keeps a concurrent run out; the unique index backs it.
    await collection.create({ slug: PLATFORM_TENANT_SLUG, name: "Clavix" });
  },
  async down({ db, session }) {
    await db
      .collection("tenants")
      .deleteMany({ slug: PLATFORM_TENANT_SLUG }, session ? { session } : {});
  },
});
