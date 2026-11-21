import { createExportThrottle } from "@/console/audit-export/throttle";
import { createConsoleAuthenticator } from "@/console/auth";
import { createConsoleBudgets } from "@/console/budgets";
import {
  CONSOLE_PATH,
  consoleAudience,
  consoleOrigin,
} from "@/console/identity";
import type { ConsoleDeps } from "@/console/plugin";
import { createJanusAdmins } from "@/modules/admins/admins.janus";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { UsersService } from "@/modules/users/users.service";
import type { OAuthHandle } from "@/oauth/routes";
import { access } from "./access";
import { adminEventReader, adminEventRecorder } from "./admin-events";
import { authEventsService } from "./audit";
import { env } from "./env";
import { exclusive } from "./exclusive";
import { invitationsOf } from "./invitations";
import { redis } from "./redis";
import { clock } from "./runtime";
import { tenantResolver, tenantsService } from "./tenancy";
import { forTenant } from "./users";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;

/** The audience of the console's access tokens: `https://console.<CLAVIX_DOMAIN>/api`. */
export const consoleResource = consoleAudience(origin);

/** The `clavix` tenant (the console signs in through it); `null` while it is missing (it cannot be suspended). */
const clavixTenant = () =>
  tenantResolver.resolveHost(`${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`);

/** The tenant with this id (suspended included: the console reads it), resolved through its own host; `null` when gone or trashed. */
async function resolveById(id: string) {
  const [tenant] = await tenantsService.liveByIds([id]);
  return tenant === undefined
    ? null
    : tenantResolver.resolveHost(`${tenant.slug}.${env.CLAVIX_DOMAIN}`);
}

/**
 * The console API's wiring: tokens verified in process by the `clavix`
 * tenant's OAuth server, permissions in the relation store, users of the
 * `clavix` tenant and tenants from the registry.
 */
export function createConsoleDeps(
  oauth: Required<Pick<OAuthHandle, "serverFor">>,
): ConsoleDeps {
  return {
    authenticate: createConsoleAuthenticator({
      audience: consoleResource,
      publicUrl: `${consoleOrigin(origin)}${CONSOLE_PATH}`,
      serverOfClavix: async () => {
        const tenant = await clavixTenant();
        return tenant === null
          ? null
          : oauth.serverFor(new Request(tenant.issuer));
      },
    }),
    access,
    now: clock,
    admins: createJanusAdmins(invitationsOf(clavixTenant)),
    users: new UsersService({
      janusOf: async (id) => {
        const tenant = await resolveById(id);
        return tenant === null ? null : forTenant(tenant);
      },
      grantsOf: async (id) => {
        const tenant = await resolveById(id);
        const server =
          tenant === null
            ? null
            : await oauth.serverFor(new Request(tenant.issuer));
        return server?.grants ?? null;
      },
      invitationsOf: (id) => invitationsOf(() => resolveById(id)),
    }),
    exclusive,
    budgets:
      redis === undefined ? undefined : createConsoleBudgets(redis.limits),
    auditExport:
      redis === undefined
        ? {}
        : { throttle: createExportThrottle(redis.limits.auditExport) },
    adminEvents: adminEventRecorder,
    activity: { admin: adminEventReader, auth: authEventsService },
    directory: {
      findUser: async (id) => {
        const tenant = await clavixTenant();
        const janus = tenant === null ? null : await forTenant(tenant);
        const user = (await janus?.findUser(id)) ?? null;
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
        const tenant = await clavixTenant();
        const janus = tenant === null ? null : await forTenant(tenant);
        if (janus === null) throw new Error("the clavix tenant is unavailable");
        return (await janus.findUser(id))?.emailVerified === true;
      },
      findUserByEmail: async (email) => {
        const tenant = await clavixTenant();
        const janus = tenant === null ? null : await forTenant(tenant);
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
    },
  };
}
