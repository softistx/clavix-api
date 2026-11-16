import type { TenantsService } from "../src/modules/tenants/tenants.service";

// New tenants require PAR; specs that call /authorize directly create their
// tenants with it off. The PAR specs keep the default.
export async function createTenantParOff(
  service: TenantsService,
  input: Parameters<TenantsService["create"]>[0],
) {
  const created = await service.create(input);
  await service.updateOAuth(created.id, (tenant) => ({
    ...tenant.oauth,
    par: { required: false },
  }));
  return created;
}
