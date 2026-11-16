import { mongo } from "@/config/db";
import type { TenantsService } from "@/modules/tenants/tenants.service";

// New tenants require PAR; specs that call /authorize directly create their
// tenants with it off. Written straight to the document, without a version
// bump: a bump would make the tenant's version differ from what a spec that
// recreates the same slug expects (the resolver cache is keyed on it).
// The PAR specs keep the default.
export async function createTenantParOff(
  service: TenantsService,
  input: Parameters<TenantsService["create"]>[0],
) {
  const created = await service.create(input);
  await mongo.db.tenants.raw.updateOne(
    { _id: created._id },
    { $set: { "oauth.par.required": false } },
  );
  return created;
}
