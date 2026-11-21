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
import { UsersService } from "@/modules/users/users.service";
import type { OAuthHandle } from "@/oauth/routes";
import { access } from "./access";
import { adminEventReader, adminEventRecorder } from "./admin-events";
import { authEventsService } from "./audit";
import { clavixTenant, consoleDirectory } from "./console-directory";
import { env } from "./env";
import { exclusive } from "./exclusive";
import { invitationsOf } from "./invitations";
import { redis } from "./redis";
import { clock, reportError, warn } from "./runtime";
import { tenantResolver, tenantsService } from "./tenancy";
import { forTenant } from "./users";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;

/** The audience of the console's access tokens: `https://console.<CLAVIX_DOMAIN>/api`. */
export const consoleResource = consoleAudience(origin);

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
    reportError,
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
      redis === undefined
        ? undefined
        : createConsoleBudgets(redis.limits, warn),
    auditExport:
      redis === undefined
        ? {}
        : { throttle: createExportThrottle(redis.limits.auditExport, warn) },
    adminEvents: adminEventRecorder,
    activity: { admin: adminEventReader, auth: authEventsService },
    directory: consoleDirectory,
  };
}
