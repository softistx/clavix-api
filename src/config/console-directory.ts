import type { ConsoleDirectory } from "@/console/context";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { env } from "./env";
import { tenantResolver, tenantsService } from "./tenancy";
import { forTenant } from "./users";

/** The `clavix` tenant (the console signs in through it); `null` while it is missing (it cannot be suspended). */
export const clavixTenant = () =>
  tenantResolver.resolveHost(`${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`);

const clavixJanus = async () => {
  const tenant = await clavixTenant();
  return tenant === null ? null : await forTenant(tenant);
};

/** The console's view of the users of the `clavix` tenant and of the tenants registry. */
export const consoleDirectory: ConsoleDirectory = {
  findUser: async (id) => {
    const user = (await (await clavixJanus())?.findUser(id)) ?? null;
    return user === null
      ? null
      : {
          id: user.id,
          email: user.email,
          name: user.name,
          active: user.active,
        };
  },
  emailVerified: async (id) => {
    const janus = await clavixJanus();
    if (janus === null) throw new Error("the clavix tenant is unavailable");
    return (await janus.findUser(id))?.emailVerified === true;
  },
  findUserByEmail: async (email) => {
    const janus = await clavixJanus();
    if (janus === null) throw new Error("the clavix tenant is unavailable");
    return janus.findByEmail(email);
  },
  tenantsByIds: async (ids) =>
    (await tenantsService.liveByIds(ids)).map((tenant) => ({
      id: tenant._id.toHexString(),
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      plan: tenant.plan,
    })),
};
