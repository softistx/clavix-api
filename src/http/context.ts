import { alxia, forwardedIp } from "@alxia/core";
import type { GraphQLContext } from "@alxia/graphql";
import { telemetry as tracing } from "@alxia/telemetry";
import type { JanusContext } from "@softistx/janus-graphql";
import { type Telemetry, withAttributes } from "@softistx/telemetry";
import { env } from "@/config/env";
import { telemetry as appTelemetry } from "@/config/telemetry";
import { tenantResolver } from "@/config/tenancy";
import {
  deviceThrottle,
  homeRealmThrottle,
  passkeyThrottle,
  signInThrottle,
  ssoStartThrottle,
  verifyThrottle,
} from "@/config/throttle";
import type { ThrottleContext } from "@/http/throttle/context";
import { isTenantless, tenantAttributes } from "@/telemetry/tenant";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import type { TenantJanus } from "@/users/tenant-janus";

// The base: what every resolver reads, decorated or derived here.
// The throttles of the anonymous operations (`ctx.signInThrottle`,
// `ctx.passkeyThrottle`, `ctx.homeRealmThrottle`, `ctx.ssoStartThrottle`, `ctx.verifyThrottle`,
// `ctx.deviceThrottle`; none: no extra limit) ride on the context, typed.
// `tenant()` is the tenant the request's host names (`null`: none, a 404 for
// the OAuth endpoints), resolved once per request, on first use.
export function createBase(
  resolver: TenantResolver = tenantResolver,
  throttles: ThrottleContext = {
    signInThrottle,
    passkeyThrottle,
    homeRealmThrottle,
    ssoStartThrottle,
    verifyThrottle,
    deviceThrottle,
  },
  telemetry: Telemetry = appTelemetry,
) {
  // `ctx.ip`: the connection's address, or, behind CLAVIX_TRUSTED_PROXIES
  // proxies, the client X-Forwarded-For names (never believed beyond them).
  return (
    alxia(
      env.CLAVIX_TRUSTED_PROXIES === 0
        ? {}
        : { ip: forwardedIp({ trusted: env.CLAVIX_TRUSTED_PROXIES }) },
    )
      // First, so the server span holds everything the request runs (D24).
      .use(
        tracing({
          instance: telemetry,
          // D24: no IP is written, so the server span leaves `client.address` off.
          clientAddress: false,
          traced: (ctx) => !isTenantless(ctx.url.pathname),
        }),
      )
      .decorate({ env })
      .decorate(throttles)
      .derive(({ request }) => {
        let tenant: Promise<ResolvedTenant | null> | undefined;
        return {
          tenant: () => {
            tenant ??= resolver.resolveRequest(request);
            return tenant;
          },
        };
      })
      // The tenant's id and plan on the server span and, inherited, on every span
      // and log under it (janus's flows included). A host that names none, or a
      // resolution that fails, leaves the request unattributed, never refused.
      .use(async (ctx, next) => {
        if (isTenantless(ctx.url.pathname)) return next();
        const attributes = await ctx
          .tenant()
          .then((tenant) => (tenant === null ? null : tenantAttributes(tenant)))
          .catch(() => null);
        if (attributes === null) return next();
        ctx.span?.attributes(attributes);
        return withAttributes(attributes, next);
      })
  );
}

export type Base = ReturnType<typeof createBase>;

// A resolver's context: graxia's and the base's. The generated `Resolvers` takes
// it (codegen.ts: `contextType`).
export type Context = Readonly<GraphQLContext<Base, JanusContext<TenantJanus>>>;
