import { getCollection } from "@softistx/mongo";
import { defineMigration } from "@softistx/mongo/migrations";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { tenants } from "@/modules/tenants/tenants.model";

export const id = "2026-11-10-clavix-tenant";

// The platform's own tenant, `clavix`: Clavix signs its console in through
// itself. An upsert on the slug, so a second run (or a database that already
// has it) keeps the one tenant and its `_id`. Down removes it for good.
export const clavixTenant = defineMigration({
  id,
  async up({ db, session }) {
    await getCollection(db, tenants)
      .withSession(session)
      .upsert({ slug: PLATFORM_TENANT_SLUG }, { name: "Clavix" });
  },
  async down({ db, session }) {
    await db
      .collection("tenants")
      .deleteMany({ slug: PLATFORM_TENANT_SLUG }, session ? { session } : {});
  },
});
